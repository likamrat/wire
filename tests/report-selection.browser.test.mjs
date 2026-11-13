import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, chooseTheme, selectActivityOption, openActivitySessions, restoreLegacySearch, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";
import { reportContents, chooseReportScope, inspectReportCopies, cancelReportPreview, openReportCreation, selectAnalyzeRequest } from "./report-journey-helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

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
    if (proofDir) await mkdir(proofDir, { recursive: true });
    async function preserved() {
        assert.deepEqual(await inventory(context.dataDir), before, "All evidence, classifications and previously saved report bytes remain unchanged");
        assert.ok(!requests.some(request => ["/api/export", "/api/move", "/api/import", "/api/record", "/api/report-file"].includes(request.path)));
        assert.deepEqual(errors, []);
    }
    return { page, runtime, context, requests, errors, preserved };
}
async function emptySelection(page) {
    assert.equal(await page.locator("[name=reportScope]:checked").inputValue(), "selected");
    assert.match(await page.locator("#scopeCount-selected").textContent(), / 0 interactions$/);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No interactions included");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#exportBtn").textContent(), "Prepare report");
    assert.equal(await page.locator("#exportBtn").isDisabled(), true);
    assert.equal(await page.locator("#activityList input:checked").count(), 0);
    assert.equal(await page.locator("#reportList input:checked").count(), 0);
}
async function clearSelection(page) {
    await openReportCreation(page);
    if (await page.locator("#reportsView").getAttribute("data-report-step") !== "1") await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await page.locator("#reportClearSelection").click();
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

test("reader Continue connects canonical selection to report Activity and exact Back without losing hidden choices or preferences", { timeout: 45000 }, async t => {
    const { page, runtime, requests, preserved } = await setup(t);
    await page.goto(runtime.url + "#reports?task=create"); await ready(page);
    await page.evaluate(() => {
        window.readerCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw new Error("No system clipboard read."); },
            async writeText(text) { window.readerCopies.push(text); },
        } });
    });
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await page.locator("#report-select-selection-5").check();
    await reportContents(page);
    await page.locator("[name=promptMode][value=original]").check();
    await page.locator("#formatOptions input[value=json]").check();
    await page.getByText("Hide specific words", { exact: true }).click();
    await page.locator("#manualTerms").fill("Keep this synthetic masking choice");
    await chooseReportScope(page, "all");
    await navigateMain(page, "activity"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await closeAnalyzeFilters(page);
    const card = page.locator("#activityList .request-row").filter({ hasText: "Selection request 01" });
    const open = card.locator(".request-card-open");
    await page.evaluate(() => document.fonts.ready);
    await open.scrollIntoViewIfNeeded();
    const origin = page.url();
    let entry = await open.boundingBox();
    await page.mouse.click(entry.x + entry.width / 2, entry.y + entry.height / 2); await ready(page);
    let readerUrl = page.url();
    const pick = page.locator("#requestReportToggle"), next = page.locator("#requestReportContinue");
    await expect(next).toBeHidden();
    await expect(next).toBeDisabled();
    await expect(page.locator("#requestReportTitle")).toHaveText("Included through the current report scope.");
    await pick.click();
    await expect(pick).toHaveText("Remove from report");
    await expect(pick).toBeFocused();
    assert.equal(page.url(), readerUrl, "Add only selects; it does not navigate or save");
    await expect(next).toBeEnabled();
    await pick.click(); await expect(next).toBeHidden(); await expect(next).toBeDisabled();
    await expect(page.locator("#activitySelectionSummary")).toContainText("1 request group included");
    await pick.click();
    await expect(page.locator("#activitySelectionSummary")).toContainText("3 request groups included");
    await expect(page.locator("#reportSelectionBar")).toBeHidden();
    const copy = page.locator('[data-reader-section="prompt"]').getByRole("button", { name: "Copy prompt", exact: true });
    await copy.focus();
    const geometry = () => page.locator(".request-original").evaluate(node => {
        const p = node.querySelector("pre").getBoundingClientRect();
        return { x: p.x, y: p.y, height: p.height, scrollY, pageHeight: document.documentElement.scrollHeight };
    });
    const beforeCopy = await geometry();
    await copy.press("Enter");
    await expect(copy).toHaveAttribute("data-copy-state", "success");
    assert.deepEqual(await geometry(), beforeCopy, "Combined report wiring cannot reintroduce Copy layout shift");
    assert.deepEqual(await page.evaluate(() => window.readerCopies), ["Selection request 01"]);
    const proof = [];
    for (const [theme, width, scale] of [["dark", 1200, 1], ["light", 375, 2]]) {
        if (await page.locator("#contextSidebar").evaluate(node => node.open)) {
            await page.locator("#closeContextSidebar").click();
            await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        }
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
        // Compare each return with its own entry layout, not coordinates from before a viewport change.
        if (!await page.locator("#contextSidebar").evaluate(node => node.open)) {
            await page.evaluate(() => document.fonts.ready);
            await open.scrollIntoViewIfNeeded();
            entry = await open.boundingBox();
            await page.mouse.click(entry.x + entry.width / 2, entry.y + entry.height / 2); await ready(page);
            readerUrl = page.url();
        }
        await next.focus();
        const position = await next.boundingBox();
        assert.ok(position.height >= 44 && position.width >= 44);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `reader-report-${theme}-${width}-${scale}.png`), fullPage: true });
        await page.keyboard.press("Enter"); await ready(page);
        await expect(page.locator("#reportStage1")).toBeVisible();
        await expect(page.locator("[name=reportScope]:checked")).toHaveValue("selected");
        await expect(page.locator("#previewSelectionSummary")).toHaveText("1 chat 3 interactions");
        await expect(page.locator("#report-select-selection-0")).toBeChecked();
        await expect(page.locator("#report-select-selection-1")).toBeChecked();
        await expect(page.locator("#report-select-selection-1").locator("xpath=ancestor::article[1]")).toBeFocused();
        assert.equal(await page.locator("#report-select-selection-1").evaluate(node => {
            const box = node.getBoundingClientRect(), inset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
            return box.top >= inset && box.bottom <= innerHeight;
        }), true, `${width}px/${scale}x: the selected continuation stays in view below the sticky header`);
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `reader-report-activity-${theme}-${width}-${scale}.png`), fullPage: true });
        await page.getByRole("button", { name: "Next report requests", exact: true }).click();
        await expect(page.locator("#report-select-selection-5")).toBeChecked();
        assert.equal(await page.locator("[name=promptMode][value=original]").isChecked(), true);
        assert.equal(await page.locator("#formatOptions input[value=json]").isChecked(), true);
        assert.equal(await page.locator("#manualTerms").inputValue(), "Keep this synthetic masking choice");
        await page.goBack(); await ready(page);
        const routeParts = url => {
            const [view, query] = new URL(url).hash.split("?");
            return [view, [...new URLSearchParams(query)].sort()];
        };
        assert.deepEqual(routeParts(page.url()), routeParts(readerUrl), "Back restores the exact route values, regardless of canonical query ordering");
        await expect(next).toBeFocused();
        assert.ok(Math.abs((await next.boundingBox()).y - position.y) < 3, "Back restores Continue's exact entry position");
        const readerReturnY = (await next.boundingBox()).y;
        await page.locator("#closeContextSidebar").click(); await ready(page);
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        assert.equal(page.url(), origin);
        await expect(open).toBeFocused();
        const cardReturnY = (await open.boundingBox()).y;
        assert.ok(Math.abs(cardReturnY - entry.y) < 3, "Reader Back restores the original filtered card in its entry layout");
        proof.push({ theme, width, scale, beforeCopy, readerReturnY, entryY: position.y, cardEntryY: entry.y, cardReturnY });
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "16px");
    assert.equal(await card.locator("input").count(), 0, "Analyze selection stays in the sidebar, not a card checkbox");
    assert.equal(requests.filter(request => ["/api/preview", "/api/privacy-review", "/api/export"].includes(request.path)).length, 0);
    if (proofDir) await writeFile(path.join(proofDir, "reader-report-join.json"), JSON.stringify(proof, null, 2));
    await preserved();
});

test("explicit reader Continue reveals a distant selected target despite prior picker search and page", { timeout: 60000 }, async t => {
    const { page, runtime, requests, preserved } = await setup(t, { total: 118, sharedPair: [112, 113] });
    await page.goto(runtime.url + "#reports?task=create"); await ready(page);
    await page.locator("#report-select-selection-2").check();
    await reportContents(page);
    await page.locator("[name=promptMode][value=original]").check();
    await page.locator("#formatOptions input[value=json]").check();
    await page.getByText("Hide specific words", { exact: true }).click();
    await page.locator("#manualTerms").fill("Keep the invented masking choice");
    await chooseReportScope(page, "selected");
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    await page.locator("#reportRequestSearch").fill("Selection request 0");
    await expect(page.locator("#reportRequestSearch")).toHaveValue("Selection request 0");
    await expect(page.locator("#reportRequestSearchCount")).toContainText("30 of 118");
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await expect(page.locator("#reportList")).toContainText("5-8 of 30");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await page.getByRole("link", { name: "Continue draft", exact: true }).click();
    await expect(page.locator("#reportRequestSearch")).toHaveValue("Selection request 0");
    await expect(page.locator("#reportList"), "Ordinary draft return retains its page").toContainText("5-8 of 30");
    await navigateMain(page, "activity"); await ready(page);
    await restoreLegacySearch(page, "Selection request 11");
    const open = page.locator("#activityList .request-row").filter({ hasText: "Selection request 113" }).locator(".request-card-open");
    await open.scrollIntoViewIfNeeded();
    const cardUrl = page.url(), cardBox = await open.boundingBox();
    await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2); await ready(page);
    const readerUrl = page.url(), next = page.locator("#requestReportContinue");
    await page.locator("#requestReportToggle").click();
    await next.focus();
    const readerY = (await next.boundingBox()).y;
    const assertRevealed = async (id, countText, search = "", pageText = "113-116 of 118") => {
        await expect(page.locator("#reportStage1")).toBeVisible();
        const chosen = page.locator(`#report-select-selection-${id}`);
        await expect(chosen).toBeChecked();
        await expect(chosen.locator("xpath=ancestor::article[1]")).toBeFocused();
        assert.equal(await chosen.evaluate(node => {
            const box = node.getBoundingClientRect(), inset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
            return box.top >= inset && box.bottom <= innerHeight;
        }), true, "The checked target is immediately in the viewport, not merely mounted on a distant page");
        assert.equal(await chosen.evaluate(node => {
            const actions = document.querySelector("#reportStage1 .report-stage-actions"), box = actions.getBoundingClientRect();
            const entry = node.closest(".report-entry").getBoundingClientRect();
            const inset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
            return entry.bottom - box.top > innerHeight - inset - 16 || box.top >= inset - 1 && box.bottom <= innerHeight;
        }), true, "When both fit, the next action stays fully visible above the revealed entry");
        assert.equal(await page.locator("#evidence-tooltip").isVisible(), false, "Revealing a row must not cover its prompt with the checkbox tooltip");
        await expect(page.locator("#reportList")).toContainText(pageText);
        await expect(page.locator("#previewSelectionSummary")).toHaveText(countText);
        await expect(page.locator("#reportRequestSearch")).toHaveValue(search);
        assert.equal(await page.locator("[name=promptMode][value=original]").isChecked(), true);
        assert.equal(await page.locator("#formatOptions input[value=json]").isChecked(), true);
        assert.equal(await page.locator("#manualTerms").inputValue(), "Keep the invented masking choice");
    };
    await next.press("Enter"); await ready(page);
    await assertRevealed(113, "1 chat 3 interactions");
    if (proofDir) await page.screenshot({ path: path.join(proofDir, "continued-distant-selected.png") });
    const contents = page.getByRole("button", { name: "Continue to contents", exact: true });
    await contents.focus(); await expect(contents).toBeInViewport();
    await contents.press("Enter"); await expect(page.locator("#reportStage2")).toBeVisible();
    await page.goBack(); await ready(page);
    assert.equal(page.url(), readerUrl);
    await expect(next).toBeFocused();
    assert.ok(Math.abs((await next.boundingBox()).y - readerY) < 3);
    await page.locator("#closeContextSidebar").click(); await ready(page);
    assert.equal(page.url(), cardUrl);
    await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - cardBox.y) < 3);

    await page.locator("#activityList .request-row").filter({ hasText: "Selection request 112" }).locator(".request-card-open").click();
    await ready(page);
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await next.click(); await ready(page);
    await assertRevealed(112, "1 chat 3 interactions");
    await selectActivityOption(page, "reportPromptAuthorFilter", ["agent"]);
    await page.locator("#reportRequestSearch").fill("Selection request 0");
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await page.goBack(); await ready(page);
    await expect(page.locator("#requestReportTitle")).toContainText("not included");
    await next.click(); await ready(page);
    await assertRevealed(112, "No interactions included");
    await expect(page.locator("#report-select-selection-112").locator("xpath=ancestor::article[1]")).toContainText("Not included with the current prompt-author choice.");
    await expect(contents).toBeDisabled();
    assert.deepEqual(await page.locator("#reportPromptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["agent"]);
    if (proofDir) await page.screenshot({ path: path.join(proofDir, "continued-alias-author-excluded.png") });
    await page.locator("#reportRequestSearch").fill("Selection request 11");
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await navigateMain(page, "activity"); await ready(page);
    await page.locator("#activityList .request-row").filter({ hasText: "Selection request 112" }).locator(".request-card-open").click(); await ready(page);
    await next.click(); await ready(page);
    await assertRevealed(112, "No interactions included", "Selection request 11", "1-4 of 9");
    await page.locator("#reportRequestSearch").fill("Selection request 02");
    await expect(page.locator("#report-select-selection-2")).toBeChecked();
    assert.equal(requests.filter(request => ["/api/preview", "/api/privacy-review", "/api/export"].includes(request.path)).length, 0);
    await preserved();
});

test("reader aliases and author exclusions stay truthful while pending and stale snapshots block both report actions", { timeout: 30000 }, async t => {
    const { page, runtime, preserved } = await setup(t);
    await page.goto(runtime.url + "#reports?task=create"); await ready(page);
    await page.locator("#report-select-selection-1").check();
    await selectActivityOption(page, "reportPromptAuthorFilter", ["agent"]);
    await navigateMain(page, "activity"); await ready(page);
    await page.locator("#activityList .request-row").filter({ hasText: "Selection request 00" }).locator(".request-card-open").click();
    await ready(page);
    const pick = page.locator("#requestReportToggle"), next = page.locator("#requestReportContinue");
    await expect(pick).toHaveText("Remove from report", { timeout: 2000 });
    await expect(page.locator("#requestReportTitle")).toContainText("not included");
    await next.click(); await ready(page);
    await expect(page.locator("#reportStage1")).toBeVisible();
    await expect(page.locator("#previewSelectionSummary")).toHaveText("No interactions included");
    await expect(page.locator("#reportPromptAuthorSummary")).toContainText("0 of 2");
    await page.goBack(); await ready(page);
    await pick.click();
    await expect(pick).toHaveText("Add to report");
    await expect(next).toBeDisabled();
    await expect(page.locator("#report-select-selection-1")).not.toBeChecked();
    await pick.click();
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        arrived(); await held;
        await route.fulfill({ status: 503, json: { error: "Synthetic snapshot is unavailable." } });
    }, { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await pending;
    await expect(pick).toBeDisabled(); await expect(next).toBeDisabled();
    const location = page.url(), selection = await page.locator("#activitySelectionSummary").textContent();
    await pick.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await next.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(page.url(), location);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    release();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(pick).toBeDisabled(); await expect(next).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await ready(page);
    await expect(pick).toBeEnabled(); await expect(next).toBeEnabled();
    await preserved();
});

test("reader report actions cannot change a dispatched save or an unconfirmed write", { timeout: 45000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t);
    const initial = await loadBoardState(context);
    const [existing] = initial.exports;
    const originalFiles = await Promise.all(Object.values(existing.files).map(file => readFile(file)));
    await page.goto(runtime.url); await ready(page);
    await page.locator("#activityList .request-row").filter({ hasText: "Selection request 00" }).locator(".request-card-open").click();
    await ready(page);
    await page.locator("#requestReportToggle").click();
    const staleActions = await page.locator("#requestReportToggle,#requestReportContinue").elementHandles();
    await page.locator("#requestReportContinue").click(); await ready(page);
    await preview(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    await page.route("**/api/export", async route => {
        await route.fetch();
        arrived(); await held; await route.abort("failed");
    }, { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click(); await pending;
    const selection = await page.locator("#activitySelectionSummary").textContent();
    await page.goBack();
    await expect(page.locator("#reportsView")).toBeVisible();
    await expect(page.locator("#message")).toContainText("Wait for the current local save");
    for (const action of staleActions) await action.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(await page.locator("#requestReportToggle,#requestReportContinue").count(), 0, "Departed sidebar actions are scrubbed");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    release();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    await navigateMain(page, "activity"); await ready(page);
    await page.locator("#activityList .request-row").filter({ hasText: "Selection request 00" }).locator(".request-card-open").click(); await ready(page);
    await expect(page.locator("#requestReportToggle")).toBeDisabled();
    await expect(page.locator("#requestReportContinue")).toBeDisabled();
    const location = page.url();
    for (const id of ["requestReportToggle", "requestReportContinue"]) {
        await page.locator("#" + id).evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    }
    assert.equal(page.url(), location);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    await navigateMain(page, "reports"); await openReportCreation(page);
    await page.getByRole("button", { name: "Check save status", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1, "No duplicate write or replacement save");
    const after = await loadBoardState(context);
    assert.equal(after.exports.length, 2, "Only the intentionally dispatched synthetic save was added");
    assert.deepEqual(after.evidence, initial.evidence);
    assert.deepEqual(await Promise.all(Object.values(existing.files).map(file => readFile(file))), originalFiles);
    assert.deepEqual(errors, []);
});

test("reader cannot replace paired report cohorts with individual selection", { timeout: 30000 }, async t => {
    const { records } = periodFixture();
    const { context } = await privateFixture(t, records);
    const initial = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url); await ready(page);
    await page.locator("#comparePeriods").click();
    for (const [name, value] of [["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"]]) await page.getByLabel(name, { exact: true }).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.locator("#createPeriodReport").click(); await ready(page);
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
    assert.equal(requests.filter(value => ["/api/preview", "/api/privacy-review", "/api/export"].includes(value)).length, 0);
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, initial.evidence);
    assert.deepEqual(after.exports, initial.exports);
    assert.deepEqual(errors, []);
});

test("report membership starts empty, spans pages, expands aliases, and clears every scope without changing data or filters", { timeout: 120000 }, async t => {
    const { page, runtime, requests, preserved } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await navigateMain(page, "reports");
    await emptySelection(page);
    assert.match(await page.locator("#scopeCount-all").textContent(), / 18 interactions$/);
    assert.equal(await page.locator("#savedLibraryTitle").textContent(), "Saved reports (1)");
    assert.ok(requests.every(request => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(request.path)),
        "Opening Reports only reads stored state and status: " + requests.map(request => request.path).join(", "));
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("[name=promptMode][value=original]").check();
    await page.locator("#formatOptions input[value=json]").check();
    await page.getByText("Hide specific words", { exact: true }).click();
    await page.locator("#manualTerms").fill("Deliberate synthetic masking term");
    await chooseReportScope(page, "selected");
    await navigateMain(page, "activity");
    await openActivitySessions(page);
    await selectAnalyzeRequest(page, page.locator("#activityList .request-row").filter({ hasText: "Selection request 01" }));
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "One report with 2 request groups included", "One overlapping selection expands to both canonical request owners");
    await page.getByRole("navigation", { name: "Analyze result pages", exact: true }).getByRole("button", { name: "Next", exact: true }).click();
    await selectAnalyzeRequest(page, page.locator("#activityList .request-row").first());
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "One report with 3 request groups included");
    const origin = page.url();
    await navigateMain(page, "reports");
    await openReportCreation(page);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "1 chat 3 interactions");
    await page.locator("#reportContextAction").click();
    assert.equal(page.url(), origin, "Back to activity retains the originating page");
    await navigateMain(page, "reports");
    const cancelled = await preview(page);
    assert.equal(cancelled.records.length, 3);
    await cancelReportPreview(page);
    await page.goBack(); await page.goForward();
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "1 chat 3 interactions");
    for (const [index, kind] of ["all", "current", "selected"].entries()) {
        if (index) {
            await navigateMain(page, "activity");
            await selectAnalyzeRequest(page, page.locator("#activityList .request-row").first());
            await navigateMain(page, "reports");
        }
        await chooseReportScope(page, kind);
        const beforeClear = requests.length, url = page.url();
        await clearSelection(page);
        await emptySelection(page);
        assert.equal(page.url(), url);
        assert.equal(requests.length, beforeClear, "Clearing membership performs no scan or persisted mutation");
        assert.equal(await page.locator("[name=promptMode][value=original]").isChecked(), true);
        assert.equal(await page.locator("#formatOptions input[value=json]").isChecked(), true);
        assert.equal(await page.locator("#manualTerms").inputValue(), "Deliberate synthetic masking term");
    }
    await navigateMain(page, "activity");
    await page.getByRole("navigation", { name: "Analyze result pages", exact: true }).getByRole("button", { name: "Previous", exact: true }).click();
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Add to report");
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await navigateMain(page, "reports");
    assert.match(await page.locator("#scopeCount-current").textContent(), / 7 interactions$/, "Current expands complete eligible requests, including a shared alias owner");
    await chooseReportScope(page, "current");
    await navigateMain(page, "activity");
    const filtered = page.url();
    await page.locator("#reportSelectionBar [data-clear-selection]").click();
    await emptySelection(page);
    assert.equal(page.url(), filtered);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "failure");
    await openActivitySessions(page);
    await selectAnalyzeRequest(page, page.locator("#activityList .request-row").first());
    await page.locator("#activityList .request-card-open").first().click();
    await page.locator("#requestReportContinue").click(); await ready(page);
    await page.locator("#reportClearSelection").click();
    await page.goBack(); await ready(page);
    assert.equal(await page.getByRole("button", { name: "Add to report", exact: true }).isVisible(), true);
    await emptySelection(page);
    await page.getByRole("button", { name: "Add to report", exact: true }).click();
    const membership = await page.locator("#activitySelectionSummary").textContent();
    await page.locator("#closeContextSidebar").click(); await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" }); await ready(page);
    await openAnalyzeFilters(page);
    await page.locator("#resetView").click(); await ready(page);
    await closeAnalyzeFilters(page);
    assert.match(new URL(page.url()).hash, /^#(?:home|analyze)/);
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

test("picker checkboxes follow resolved shared-call membership without losing focus or hidden selections", { timeout: 30000 }, async t => {
    const { page, runtime, preserved } = await setup(t);
    await page.goto(runtime.url + "#reports?task=create"); await ready(page);
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

test("reader membership and canonical report checks reconcile aliases and rejected mutations in place", { timeout: 30000 }, async t => {
    const { page, runtime, preserved } = await setup(t);
    await page.goto(runtime.url + "#reports?task=create"); await ready(page);
    const nextReportPage = page.getByRole("button", { name: "Next report requests", exact: true });
    const previousReportPage = page.getByRole("button", { name: "Previous report requests", exact: true });
    for (let index = 0; index < 3; index++) await nextReportPage.click();
    await page.locator("#report-select-selection-13").check();
    for (let index = 0; index < 3; index++) await previousReportPage.click();
    await navigateMain(page, "activity"); await ready(page);
    const reportA = page.locator("#report-select-selection-0"), reportB = page.locator("#report-select-selection-1");
    const reportC = page.locator("#report-select-selection-2"), toggle = page.locator("#requestReportToggle");
    const pageState = await page.locator("#activityPager").innerText();
    async function open(id) {
        await page.locator(`.request-row[data-view-key="request:selection-${id}"] .request-card-open`).click();
        await page.locator("#contextSidebar[open]").waitFor();
    }
    async function close() {
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    }
    await open(0); await expect(toggle).toHaveText("Add to report"); await toggle.click(); await close();
    await open(1); await expect(toggle).toHaveText("Add to report"); await toggle.click(); await close();
    await open(0); await expect(toggle).toHaveText("Remove from report"); await toggle.click();
    await expect(toggle).toHaveText("Add to report"); await expect(toggle).toBeFocused();
    await close();
    assert.equal(await reportA.isChecked(), false);
    assert.equal(await reportB.isChecked(), false, "Removing A's aliases also removes explicitly selected B");
    assert.match(await page.locator("#activitySelectionSummary").innerText(), /1 request group included/);
    await open(1); await expect(toggle).toHaveText("Add to report"); await toggle.click();
    await expect(toggle).toHaveText("Remove from report");
    assert.equal(await reportA.isChecked(), true, "Adding B in the reader expands canonical A in Reports");
    assert.equal(await reportB.isChecked(), true);
    await page.evaluate(() => {
        window.mountedSelectionControls = ["requestReportToggle", "report-select-selection-0",
            "report-select-selection-1", "report-select-selection-2"].map(id => document.getElementById(id));
    });

    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        arrived(); await held; await route.fulfill({ response });
    }, { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await pending;
    await expect(toggle).toBeDisabled();
    await toggle.evaluate(node => { node.disabled = false; node.click(); });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveText("Remove from report");
    assert.equal(await reportB.isChecked(), true, "A rejected reader removal keeps the authoritative selection");
    await reportC.evaluate(node => {
        node.checked = true;
        node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await reportC.isChecked(), false, "A rejected addition cannot enter canonical report membership");
    await reportA.evaluate(node => {
        node.checked = false;
        node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await reportA.isChecked(), true, "Rejected Reports edits restore canonical rather than explicit membership");
    assert.equal(await reportB.isChecked(), true);
    assert.match(await page.locator("#activitySelectionSummary").innerText(), /3 request groups included/);
    assert.equal(await page.locator("#activityPager").innerText(), pageState);
    assert.match(await page.locator("#reportList").innerText(), /1-4 of 18/);
    assert.equal(await page.evaluate(() => window.mountedSelectionControls.every(node => node === document.getElementById(node.id))), true);
    release(); await ready(page); await close();
    await navigateMain(page, "reports"); await openReportCreation(page);
    for (let index = 0; index < 3; index++) await nextReportPage.click();
    assert.equal(await page.locator("#report-select-selection-13").isChecked(), true, "Unrelated selections on other pages survive all mutations");
    await preserved();
});

test("clear discards per-copy edits and attestation, including late previews and late snapshots", { timeout: 120000 }, async t => {
    const { page, runtime, requests, preserved } = await setup(t);
    await page.goto(runtime.url + "#reports?task=create"); await ready(page);
    await page.locator("#reportList input[type=checkbox]").first().check();
    await preview(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison textarea").first().fill("EDITED_SELECTION_COPY");
    await clearSelection(page);
    await emptySelection(page);
    await page.waitForFunction(() => document.activeElement.id === "reportStepTitle1");
    assert.equal(await page.locator("#reportReviewBody").textContent(), "");
    await page.locator("#reportList input[type=checkbox]").first().check();
    const fresh = await preview(page);
    assert.ok(!JSON.stringify(fresh.records).includes("EDITED_SELECTION_COPY"));
    assert.deepEqual(requests.filter(request => request.path === "/api/preview").at(-1).body.options.overrides, []);
    const confirm = page.getByRole("button", { name: "Save report", exact: true, includeHidden: true });
    assert.equal(await confirm.isDisabled(), true);
    await page.locator(".attestation input[data-review-control]").check();
    assert.equal(await confirm.isDisabled(), true);
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    await clearSelection(page); await cancelled;
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
    await clearSelection(page);
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
    await closeAnalyzeFilters(page);
    await page.locator("#reportSelectionBar [data-clear-selection]").click();
    releaseSnapshot(); await ready(page);
    await emptySelection(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "failure");
    await navigateMain(page, "reports");
    await emptySelection(page);
    await preserved();
});

test("selection summaries and shared filters stay compact and unclipped in both themes at 375, 820 and 1200", { timeout: 120000 }, async t => {
    const { page, runtime, preserved } = await setup(t), measurements = [];
    await page.goto(runtime.url); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await navigateMain(page, "reports");
        await openReportCreation(page);
        if (await page.locator("#reportsView").getAttribute("data-report-step") !== "1") await page.getByRole("button", { name: "1. Activity", exact: true }).click();
        if (await page.locator("#reportClearSelection").isVisible()) await page.locator("#reportClearSelection").click();
        await emptySelection(page);
        assert.equal(await page.locator("#reportClearSelection").isVisible(), false, "Empty selection has no redundant clear action.");
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `reports-empty-${theme}-${width}.png`), fullPage: true });
        await chooseReportScope(page, "all");
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), "1 chat 18 interactions");
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `reports-included-${theme}-${width}.png`), fullPage: true });
        await reportContents(page);
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
        const report = await page.locator("#contextSidebarFooter .report-stage-actions").evaluate(node => {
            const box = node.getBoundingClientRect();
            const button = node.querySelector("#exportBtn"), style = getComputedStyle(button);
            return { left: box.left, right: box.right, overflow: node.scrollWidth > node.clientWidth, buttonHeight: button.getBoundingClientRect().height, radius: style.borderRadius,
                expectedRadius: getComputedStyle(document.documentElement).getPropertyValue("--radius-primary").trim() };
        });
        assert.ok(report.left >= 0 && report.right <= width);
        assert.equal(report.overflow, false);
        assert.equal(report.radius, report.expectedRadius);
        assert.equal(report.buttonHeight, 44);
        await page.locator("#closeContextSidebar").click();
        await navigateMain(page, "activity"); await ready(page);
        await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
        await openAnalyzeFilters(page);
        const metrics = await page.evaluate(() => {
            const rect = (node, painted = false) => {
                const style = getComputedStyle(node), box = node.getBoundingClientRect(), paint = getComputedStyle(node, "::before");
                return { radius: style.borderRadius, filter: node.classList.contains("select-trigger-filter"), height: box.height,
                    natural: Math.max(parseFloat(style.minHeight) || 0, parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)),
                    right: box.right, actionable: node.matches("button,a"), backgroundSize: style.backgroundSize, clipped: node.scrollWidth > node.clientWidth + 1, paint: painted ? box.height - parseFloat(paint.top) - parseFloat(paint.bottom) : box.height };
            };
            return {
                fieldRadius: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--radius-field")),
                controlRadius: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--radius-control")),
                resultRadius: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--radius-pill")),
                filters: [...document.querySelectorAll("#filters .select-trigger")].map(node => rect(node, true)),
                chips: [...document.querySelectorAll(".filter-chip")].map(node => rect(node, true)),
                results: [...document.querySelectorAll("#activityList .recorded-result")].map(node => rect(node, node.matches(".result-link"))),
                navigation: [...document.querySelectorAll(".primary-navigation a")].map(node => rect(node)),
                formats: [...document.querySelectorAll(".format-choices label")].map(node => getComputedStyle(node).borderRadius),
                overflow: document.documentElement.scrollWidth > innerWidth,
            };
        });
        assert.equal(metrics.overflow, false);
        for (const filter of metrics.filters) { assert.equal(parseFloat(filter.radius), filter.filter ? 24 : metrics.fieldRadius); assert.equal(filter.height, 44); assert.equal(filter.paint, filter.filter ? 44 : 36); }
        for (const chip of metrics.chips) { assert.equal(parseFloat(chip.radius), metrics.controlRadius); assert.equal(chip.height, 44); assert.equal(chip.paint, 32); }
        for (const result of metrics.results) {
            assert.equal(parseFloat(result.radius), metrics.resultRadius);
            assert.ok(Math.abs(result.height - (result.actionable ? 44 : result.natural)) <= 1, "Asta labels use their natural line box; actions retain a full target");
            assert.equal(result.paint, result.actionable ? 24 : result.height);
            assert.equal(result.clipped, false); assert.ok(result.right <= width);
        }
        for (const nav of metrics.navigation) assert.equal(nav.radius, "6px", "Sidebar rows follow the quiet reference, not action pills");
        assert.ok(metrics.formats.every(radius => parseFloat(radius) === 0), "Report file choices are plain labeled checkboxes, not pill cards");
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `activity-pills-${theme}-${width}.png`), fullPage: true });
        await openAnalyzeFilters(page);
        await page.locator("#layerFilter-control").click();
        assert.equal(await page.locator(".select-popup").evaluate(node => getComputedStyle(node).borderRadius), "20px");
        assert.equal(await page.locator(".select-popup .select-option-description").count(), 0);
        assert.deepEqual(await page.locator(".select-option").allInnerTexts(), await page.locator("#layerFilter option").allTextContents());
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `activity-popup-${theme}-${width}.png`) });
        await page.keyboard.press("Escape");
        measurements.push({ theme, width, report, ...metrics });
    }
    if (proofDir) await writeFile(path.join(proofDir, "selection-pill-measurements.json"), JSON.stringify(measurements, null, 2));
    await preserved();
});
