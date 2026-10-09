import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, chooseTheme, selectActivityOption, openActivitySessions } from "./helpers.mjs";
import { reportContents, chooseReportScope, inspectReportCopies, cancelReportPreview } from "./report-journey-helpers.mjs";

const proofDir = process.env.WORKIQ_SELECTION_PROOFS;
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
async function setup(t) {
    const records = Array.from({ length: 18 }, (_, index) => {
        const record = fixture(`selection-${index}`);
        record.userPrompt.text = `Selection request ${String(index).padStart(2, "0")}`;
        record.toolCalls[0].toolSucceeded = index % 3 === 2 ? undefined : index % 3 === 0;
        record.toolCalls[0].reportedOutcome = index % 3 === 0 ? "succeeded" : index % 3 === 1 ? "failed" : "unknown";
        return record;
    });
    records[1].toolCalls.unshift(structuredClone(records[0].toolCalls[0]));
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const initial = await loadBoardState(context);
    const previous = await controller.preview("existing-synthetic-report", undefined, { promptMode: "none", formats: ["html"] }, { kind: "selected", revision: initial.revision, scenarioIds: ["selection-0"] });
    await controller.review("existing-synthetic-report", previous.previewId, true);
    await controller.confirm("existing-synthetic-report", previous.previewId, true);
    const runtime = await startServer(context, controller, { port: 0 });
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
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText: () => { throw new Error("Clipboard is excluded from selection proof."); },
        writeText: () => { throw new Error("Clipboard is excluded from selection proof."); },
    } }));
    if (proofDir) await mkdir(proofDir, { recursive: true });
    async function preserved() {
        assert.deepEqual(await inventory(context.dataDir), before, "All evidence, classifications and previously saved report bytes remain unchanged");
        assert.ok(!requests.some(request => ["/api/export", "/api/move", "/api/import", "/api/record", "/api/report-file"].includes(request.path)));
        assert.deepEqual(errors, []);
    }
    return { page, runtime, context, requests, preserved };
}
async function emptySelection(page) {
    assert.equal(await page.locator("[name=reportScope]:checked").inputValue(), "selected");
    assert.equal(await page.locator("#scopeCount-selected").textContent(), "0 request groups");
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#exportBtn").textContent(), "Scan and preview");
    assert.equal(await page.locator("#exportBtn").isDisabled(), true);
    assert.equal(await page.locator("#activityList input:checked").count(), 0);
    assert.equal(await page.locator("#reportList .report-entry").count(), 0);
}
async function preview(page) {
    await reportContents(page);
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const response = await (await pending).json();
    await page.locator(".attestation input[data-review-control]").waitFor();
    await inspectReportCopies(page);
    return response;
}

test("report membership starts empty, spans pages, expands aliases, and clears every scope without changing data or filters", { timeout: 120000 }, async t => {
    const { page, runtime, requests, preserved } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await navigateMain(page, "reports");
    await emptySelection(page);
    assert.equal(await page.locator("#scopeCount-all").textContent(), "18 request groups");
    assert.match(await page.locator("#savedReportCount").textContent(), /^1 report\./);
    assert.ok(requests.every(request => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview"].includes(request.path)), "Opening Reports only reads the snapshot, collection status and current insight overview");
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("[name=promptMode][value=original]").check();
    await page.locator("#formatOptions input[value=json]").check();
    await page.getByText("Additional masking", { exact: true }).click();
    await page.locator("#manualTerms").fill("Deliberate synthetic masking term");
    await chooseReportScope(page, "selected");
    await navigateMain(page, "activity");
    await openActivitySessions(page);
    await page.locator("#activityList .request-row").filter({ hasText: "Selection request 01" }).locator("input").check();
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "One report · 2 request groups included", "One overlapping selection expands to both canonical request owners");
    await page.getByRole("button", { name: "Next request groups", exact: true }).click();
    await page.locator("#activityList input").first().check();
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "One report · 3 request groups included");
    const origin = page.url();
    await navigateMain(page, "reports");
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 3 request groups included");
    await page.locator("#pageAction").click();
    assert.equal(page.url(), origin, "Back to activity retains the originating page");
    await navigateMain(page, "reports");
    const cancelled = await preview(page);
    assert.equal(cancelled.records.length, 3);
    await cancelReportPreview(page);
    await page.goBack(); await page.goForward();
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 3 request groups included");
    for (const [index, kind] of ["all", "current", "selected"].entries()) {
        if (index) {
            await navigateMain(page, "activity");
            await page.locator("#activityList input").first().check();
            await navigateMain(page, "reports");
        }
        await chooseReportScope(page, kind);
        const beforeClear = requests.length, url = page.url();
        await page.locator("#reportClearSelection").click();
        await emptySelection(page);
        assert.equal(page.url(), url);
        assert.equal(requests.length, beforeClear, "Clearing membership performs no scan or persisted mutation");
        assert.equal(await page.locator("[name=promptMode][value=original]").isChecked(), true);
        assert.equal(await page.locator("#formatOptions input[value=json]").isChecked(), true);
        assert.equal(await page.locator("#manualTerms").inputValue(), "Deliberate synthetic masking term");
    }
    await navigateMain(page, "activity");
    await page.getByRole("button", { name: "Previous request groups", exact: true }).click();
    assert.equal(await page.locator("#activityList input:checked").count(), 0, "Clearing includes previous pages");
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await navigateMain(page, "reports");
    assert.equal(await page.locator("#scopeCount-current").textContent(), "7 request groups", "Current expands complete eligible requests, including a shared alias owner");
    await chooseReportScope(page, "current");
    await navigateMain(page, "activity");
    const filtered = page.url();
    await page.locator("#reportSelectionBar [data-clear-selection]").click();
    await emptySelection(page);
    assert.equal(page.url(), filtered);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "failure");
    await openActivitySessions(page);
    await page.locator("#activityList input").first().check();
    await page.locator("#activityList .request-link").first().click();
    await page.locator("#reportSelectionBar [data-clear-selection]").click();
    assert.equal(await page.getByRole("button", { name: "Add to report", exact: true }).isVisible(), true);
    await emptySelection(page);
    await page.getByRole("button", { name: "Add to report", exact: true }).click();
    const membership = await page.locator("#activitySelectionSummary").textContent();
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), membership, "Reset to Home does not clear explicit report IDs");
    await page.locator("#reportSelectionBar [data-clear-selection]").click();
    await navigateMain(page, "reports");
    await page.reload(); await ready(page);
    await emptySelection(page);
    assert.equal(await page.locator("[name=promptMode]:checked").inputValue(), "masked", "Report preferences are explicitly panel-lifetime, not stored");
    await chooseReportScope(page, "all");
    await page.reload(); await ready(page);
    await emptySelection(page);
    await preserved();
});

test("clear discards per-copy edits and attestation, including late previews and late snapshots", { timeout: 120000 }, async t => {
    const { page, runtime, requests, preserved } = await setup(t);
    await page.goto(runtime.url + "#activity"); await ready(page);
    await page.locator("#activityList input").first().check();
    await navigateMain(page, "reports");
    await preview(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison textarea").first().fill("EDITED_SELECTION_COPY");
    await page.locator("#reportClearSelection").click();
    await emptySelection(page);
    await page.waitForFunction(() => document.activeElement.id === "reportStepTitle1");
    assert.equal(await page.locator("#reportReviewBody").textContent(), "");
    await navigateMain(page, "activity");
    await page.locator("#activityList input").first().check();
    await navigateMain(page, "reports");
    const fresh = await preview(page);
    assert.ok(!JSON.stringify(fresh.records).includes("EDITED_SELECTION_COPY"));
    assert.deepEqual(requests.filter(request => request.path === "/api/preview").at(-1).body.options.overrides, []);
    const confirm = page.getByRole("button", { name: "Confirm local export", exact: true, includeHidden: true });
    assert.equal(await confirm.isDisabled(), true);
    await page.locator(".attestation input[data-review-control]").check();
    assert.equal(await confirm.isDisabled(), true);
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    await page.locator("#reportClearSelection").click(); await cancelled;
    await emptySelection(page);
    assert.equal(await page.locator("#reportReviewBody [data-review-control]").count(), 0);

    await chooseReportScope(page, "all");
    await reportContents(page);
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { arrived = resolve; });
    await page.route("**/api/preview", async route => {
        const response = await route.fetch();
        arrived(); await held; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#exportBtn").click(); await pending;
    await page.locator("#reportClearSelection").click();
    const lateCancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    release(); await lateCancelled;
    await emptySelection(page);
    assert.equal(await page.locator("#overlay").evaluate(node => node.open), false);
    assert.equal(await page.locator("#reportReviewBody [data-review-control]").count(), 0);

    await chooseReportScope(page, "all");
    await navigateMain(page, "activity");
    let releaseSnapshot, arrivedSnapshot;
    const snapshotHeld = new Promise(resolve => { releaseSnapshot = resolve; });
    const snapshotPending = new Promise(resolve => { arrivedSnapshot = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        arrivedSnapshot(); await snapshotHeld; await route.fulfill({ response });
    }, { times: 1 });
    await selectActivityOption(page, "outcomeFilter", "failure"); await snapshotPending;
    await page.locator("#reportSelectionBar [data-clear-selection]").click();
    releaseSnapshot(); await ready(page);
    await emptySelection(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "failure");
    await navigateMain(page, "reports");
    await emptySelection(page);
    await preserved();
});

test("selection summaries and shared pills stay compact and unclipped in light/navy at 375, 820 and 1200", { timeout: 120000 }, async t => {
    const { page, runtime, preserved } = await setup(t), measurements = [];
    await page.goto(runtime.url); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await navigateMain(page, "reports");
        if (await page.locator("#reportClearSelection").isVisible()) await page.locator("#reportClearSelection").click();
        await emptySelection(page);
        assert.equal(await page.locator("#reportClearSelection").isVisible(), false, "Empty selection has no redundant clear action.");
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `reports-empty-${theme}-${width}.png`), fullPage: true });
        await chooseReportScope(page, "all");
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "One report · 18 request groups included");
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `reports-included-${theme}-${width}.png`), fullPage: true });
        await reportContents(page);
        const report = await page.locator("#reportStage2 .report-stage-actions").evaluate(node => {
            const box = node.getBoundingClientRect();
            const button = node.querySelector("#exportBtn"), style = getComputedStyle(button);
            return { left: box.left, right: box.right, overflow: node.scrollWidth > node.clientWidth, buttonHeight: button.getBoundingClientRect().height, radius: style.borderRadius };
        });
        assert.ok(report.left >= 0 && report.right <= width);
        assert.equal(report.overflow, false);
        assert.equal(report.radius, "8px");
        assert.equal(report.buttonHeight, 44);
        await navigateMain(page, "activity"); await ready(page);
        await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
        const metrics = await page.evaluate(() => {
            const rect = (node, painted = false) => {
                const style = getComputedStyle(node), box = node.getBoundingClientRect(), paint = getComputedStyle(node, "::before");
                return { radius: style.borderRadius, height: box.height, right: box.right, actionable: node.matches("button,a"), backgroundSize: style.backgroundSize, clipped: node.scrollWidth > node.clientWidth + 1, paint: painted ? box.height - parseFloat(paint.top) - parseFloat(paint.bottom) : box.height };
            };
            return {
                fieldRadius: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--radius-field")),
                controlRadius: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--radius-control")),
                filters: [...document.querySelectorAll("#filters .select-trigger")].map(node => rect(node, true)),
                chips: [...document.querySelectorAll(".filter-chip")].map(node => rect(node, true)),
                results: [...document.querySelectorAll("#activityList .recorded-result")].map(node => rect(node, node.matches(".result-link"))),
                navigation: [...document.querySelectorAll(".primary-navigation a")].map(node => rect(node)),
                formats: [...document.querySelectorAll(".format-choices label")].map(node => getComputedStyle(node).borderRadius),
                overflow: document.documentElement.scrollWidth > innerWidth,
            };
        });
        assert.equal(metrics.overflow, false);
        for (const filter of metrics.filters) { assert.equal(parseFloat(filter.radius), metrics.fieldRadius); assert.equal(filter.height, 44); assert.equal(filter.paint, 36); }
        for (const chip of metrics.chips) { assert.equal(parseFloat(chip.radius), metrics.controlRadius); assert.equal(chip.height, 44); assert.equal(chip.paint, 32); }
        for (const result of metrics.results) { assert.equal(parseFloat(result.radius), 6); assert.equal(result.height, result.actionable ? 44 : 22); assert.equal(result.paint, result.actionable ? 24 : 22); assert.equal(result.clipped, false); assert.ok(result.right <= width); }
        for (const nav of metrics.navigation) assert.equal(nav.radius, "6px", "Sidebar rows follow the quiet reference, not action pills");
        assert.ok(metrics.formats.every(radius => parseFloat(radius) === metrics.controlRadius));
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `activity-pills-${theme}-${width}.png`), fullPage: true });
        await page.locator("#layerFilter-control").click();
        assert.equal(await page.locator(".select-popup").evaluate(node => getComputedStyle(node).borderRadius), "12px");
        assert.equal(await page.locator(".select-popup .select-option-description").count(), 0);
        assert.deepEqual(await page.locator(".select-option").allInnerTexts(), await page.locator("#layerFilter option").allTextContents());
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `activity-popup-${theme}-${width}.png`) });
        await page.keyboard.press("Escape");
        measurements.push({ theme, width, report, ...metrics });
    }
    if (proofDir) await writeFile(path.join(proofDir, "selection-pill-measurements.json"), JSON.stringify(measurements, null, 2));
    await preserved();
});
