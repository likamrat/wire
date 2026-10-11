import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, scanReport, inspectReportCopies, reportContents, openReportLibrary, openReportCreation } from "./report-journey-helpers.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashes = async entries => Promise.all(entries.map(async entry => [
    entry.bundleId, await Promise.all(Object.entries(entry.files).map(async ([name, file]) => [name, digest(await readFile(file))])),
]));

async function setup(t, savedCount = 0) {
    const { context } = await privateFixture(t, [fixture()]);
    const controller = createExportController(context);
    if (savedCount) t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T12:00:00.000Z") });
    for (let index = 0; index < savedCount; index++) {
        t.mock.timers.setTime(Date.parse("2026-10-01T12:00:00.000Z") + Math.floor(index / 2) * 1000);
        const state = await loadBoardState(context);
        const preview = await controller.preview("synthetic-seed", undefined, {
            promptMode: "masked", formats: ["html", "json"],
        }, { kind: "all", revision: state.revision });
        await controller.review("synthetic-seed", preview.previewId, true);
        await controller.confirm("synthetic-seed", preview.previewId, true);
    }
    if (savedCount) t.mock.timers.reset();
    const runtime = await startServer(context, controller, { port: 0 });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const browserContext = await browser.newContext({ viewport: { width: 1200, height: 960 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { context, page, errors, runtime, requests, controller };
}

async function save(page) {
    await chooseReportScope(page, "all");
    await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
}
async function history(page) {
    await openReportLibrary(page);
}
async function deleteReport(page, id) {
    await history(page);
    await page.locator("#savedReportSearch").fill(id);
    const row = page.locator("#bundleList details").first();
    if (!await row.evaluate(node => node.open)) await row.locator(":scope > summary").click();
    await row.getByRole("button", { name: "Delete report", exact: true }).click();
    const dialog = page.locator("dialog[open]").filter({ has: page.locator("#savedArtifactDeleteTitle") });
    await dialog.getByRole("button", { name: "Delete report", exact: true }).click();
    return dialog;
}

test("UX-001 ordinary copy edit has one accurate recovery instruction", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t);
    await chooseReportScope(page, "all");
    await scanReport(page);
    await inspectReportCopies(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    const editor = page.locator(".prompt-comparison textarea").first();
    await editor.fill("Artificial revised report copy");
    const guidance = await page.locator("#reportJourneyError:visible,.rebuild-preview:visible").allTextContents();
    assert.equal(await page.getByRole("button", { name: "Complete disclosure review", exact: true }).isDisabled(), true);
    assert.doesNotMatch(guidance.join("\n"), /Return to Contents/i, "Ordinary copy edits must not direct the user away from available Rebuild preview");
    assert.equal(guidance.length, 1, "Exactly one recovery instruction");
    assert.match(guidance[0], /Rebuild preview/);
    await page.evaluate(() => {
        window.guidanceMutations = 0;
        new MutationObserver(changes => { window.guidanceMutations += changes.length; }).observe(document.querySelector(".rebuild-preview"), { childList: true, subtree: true, characterData: true });
    });
    await editor.press("End");
    await editor.pressSequentially(" keeps focus");
    assert.equal(await editor.evaluate(node => document.activeElement === node && node.selectionStart === node.value.length), true);
    assert.equal(await page.evaluate(() => window.guidanceMutations), 0, "No per-keystroke announcement mutation");
    const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    const preview = await (await rebuilt).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.ok(preview.promptReview.some(prompt => prompt.text?.includes("Artificial revised report copy keeps focus")));
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    await inspectReportCopies(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison").first().getByLabel("Omit this prompt from the report").check();
    assert.equal(await page.locator("#reportJourneyError:visible").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Complete disclosure review", exact: true }).isDisabled(), true);
    const omitted = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    assert.equal((await (await omitted).json()).promptReview[0].omitted, true);
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(value => value === "/api/export").length, 0);
});

test("UX-002 seventh actual saved report is descriptive and on first history page", { timeout: 90000 }, async t => {
    const { page, context } = await setup(t, 6);
    const before = await loadBoardState(context), bytes = await hashes(before.exports);
    await save(page);
    const state = await loadBoardState(context), newest = state.exports.at(-1);
    assert.equal(state.exports.length, 7);
    await openReportLibrary(page);
    const summaries = await page.locator("#bundleList details > summary").allTextContents();
    assert.equal(summaries.length, 6);
    assert.match(summaries[0], /Masked prompts.*HTML/i, "Collapsed saved reports need safe identifying metadata");
    await page.locator("#bundleList details > summary").first().click();
    assert.ok((await page.locator("#bundleList details").first().innerText()).includes(newest.bundleId), "Newest report is the first row");
    assert.deepEqual(state.exports.slice(0, 6), before.exports, "Presentation sorting cannot reorder or rewrite the persisted index");
    assert.deepEqual(await hashes(state.exports.slice(0, 6)), bytes, "Old artifact bytes remain frozen");
    const first = page.locator("#bundleList details").first();
    assert.match(await first.locator(".saved-report-management").textContent(), /1 request group/, "Secondary membership remains available in Manage");
    await first.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await first.evaluate(node => node.open), false);
    await page.keyboard.press("Space");
    assert.equal(await first.evaluate(node => node.open), true);
    assert.equal(await first.locator(":scope > summary").evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await page.locator("#savedReportSearch").fill(before.exports[0].bundleId);
    assert.equal(await page.locator("#bundleList details").count(), 1, "Search filters all rows before pagination");
    assert.match(await page.locator("#bundleList").textContent(), new RegExp(before.exports[0].bundleId));
    await page.locator("#savedReportSearch").fill("SYNTHETIC_PRIVATE_PROMPT");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/);
    await page.locator("#clearSavedReportSearch").click();
    assert.match(await page.locator("#bundleList").textContent(), /7-7 of 7 saved reports/);
    await page.getByRole("button", { name: "Previous saved reports", exact: true }).click();
    await page.locator("#savedReportSearch").fill("masked HTML");
    const snapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.locator("#savedReportSearch").focus();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await snapshot; await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "masked HTML");
    assert.equal(await page.evaluate(() => document.activeElement.id), "savedReportSearch");
    await navigateMain(page, "activity"); await page.goBack();
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "masked HTML");
    await page.locator("#clearSavedReportSearch").click();
    await history(page);
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 1200]) for (const size of ["100%", "200%"]) {
        await page.setViewportSize({ width, height: 960 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
        const dimensions = await page.locator("#bundleList details > summary").evaluateAll(nodes => nodes.map(node => ({
            height: node.getBoundingClientRect().height, clipped: node.scrollWidth > node.clientWidth + 1,
        })));
        assert.ok(dimensions.every(row => row.height >= 44 && !row.clipped), `${theme}/${width}/${size}: readable 44px summaries`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${size}: no page overflow`);
        if (process.env.WIRE_REPORT_UX_PROOFS && width === 375 && size === "200%") {
            await mkdir(process.env.WIRE_REPORT_UX_PROOFS, { recursive: true });
            await page.locator("#bundleList details").first().screenshot({ path: path.join(process.env.WIRE_REPORT_UX_PROOFS, `history-${theme}-${width}-${size}.png`) });
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#savedReportSearch").fill("masked");
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await save(page);
    const next = (await loadBoardState(context)).exports.at(-1);
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "masked", "Explicit saves keep the history query");
    assert.match(await page.locator("#bundleList").textContent(), /1-6 of 8 saved reports/);
    assert.equal(await page.locator("#bundleList details").first().getAttribute("data-disclosure-key"), "bundle:" + next.bundleId, "Explicit save returns only the active history page to the top");
});

test("UX-003 deleting the displayed saved report removes its ready result", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t);
    await chooseReportScope(page, "all");
    await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    await openReportLibrary(page);
    await page.locator("#bundleList details > summary").first().click();
    await page.locator("#bundleList").getByRole("button", { name: "Delete report", exact: true }).click();
    const dialog = page.locator("dialog[open]").filter({ has: page.locator("#savedArtifactDeleteTitle") });
    await dialog.getByRole("button", { name: "Delete report", exact: true }).click();
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(await page.locator("#reportStage4 .report-save-success").count(), 0, "A deleted report must not still be claimed ready");
    assert.equal(await page.locator("#reportStage4 .report-downloads button").count(), 0, "A deleted report has no download controls");
});

test("UX-001 non-copy source and contents invalidations never retain the copy-only rebuild action", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t);
    await chooseReportScope(page, "all"); await scanReport(page); await inspectReportCopies(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison textarea").first().fill("Artificial changed text");
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await read; await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Rebuild preview", exact: true }).count(), 0);
    assert.match(await page.locator("#reportJourneyError").textContent(), /new|fresh.*preview/i);
    assert.equal(await page.getByRole("button", { name: "4. Save", exact: true }).isDisabled(), true);
    for (const choice of ["mode", "format", "scope"]) {
        await scanReport(page);
        if (choice === "scope") await chooseReportScope(page, "selected");
        else {
            await reportContents(page);
            if (choice === "mode") await page.locator("[name=promptMode][value=original]").check();
            else await page.locator("#formatOptions input[value=json]").check();
        }
        assert.equal(await page.getByRole("button", { name: "3. Review", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "4. Save", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "Rebuild preview", exact: true }).count(), 0);
    }
    assert.equal(requests.filter(value => value === "/api/export").length, 0);
});

test("UX-002 deterministic ties, truthful legacy/unknown metadata and long frozen dates remain safe", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t, 6);
    const initial = await loadBoardState(context), frozen = await hashes(initial.exports);
    await updateBoardState(context, state => {
        delete state.exports[0].kind;
        delete state.exports[0].preparedAt;
        delete state.exports[0].preparedAtDisplay;
        delete state.exports[0].promptMode;
        delete state.exports[0].formats;
        delete state.exports[0].selectionScope;
        state.exports[1].preparedAt = "not-a-timestamp";
        delete state.exports[1].preparedAtDisplay;
        state.exports[2].preparedAtDisplay = "jeudi 1 octobre 2026 a 12:00:01 UTC - date de preparation conservee";
    });
    const registered = await loadBoardState(context);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await history(page);
    const ids = await page.locator("#bundleList details").evaluateAll(nodes => nodes.map(node => node.dataset.disclosureKey));
    assert.deepEqual(ids, [5, 4, 3, 2, 0, 1].map(index => "bundle:" + registered.exports[index].bundleId), "Exact timestamp ties use reverse registration order; missing dates remain stable at the end");
    const labels = await page.locator("#bundleList details > summary").allTextContents();
    assert.match(labels[4], /Report.*Preparation time unavailable/);
    assert.doesNotMatch(labels[4], /Masked|Original|HTML|request group/);
    assert.match(labels[5], /Preparation time unavailable/);
    assert.match(labels[3], /jeudi 1 octobre/);
    assert.ok(labels[0].includes(registered.exports[5].bundleId), "Identical metadata gets full-ID disambiguation");
    await page.locator("#savedReportSearch").fill("[");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/, "Search is literal, not a regex");
    await page.locator("#savedReportSearch").fill(registered.exports[0].bundleId);
    await page.locator("#bundleList details > summary").click();
    assert.match(await page.locator("#bundleList .mono").first().textContent(), new RegExp(registered.exports[0].bundleId));
    assert.deepEqual((await loadBoardState(context)).exports, registered.exports);
    assert.deepEqual(await hashes(registered.exports), frozen);
});

test("UX-003 cross-tab named deletion invalidates only the displayed target through normal polling", { timeout: 60000 }, async t => {
    const { page, context, runtime } = await setup(t, 1);
    const original = await loadBoardState(context), bytes = await hashes(original.exports);
    await save(page);
    const saved = (await loadBoardState(context)).exports.at(-1);
    const other = await page.context().newPage();
    await other.goto(runtime.url + "#reports");
    await other.locator('#workspace[aria-busy="false"]').waitFor();
    const dialog = await deleteReport(other, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=unavailable]").waitFor({ timeout: 15000 });
    assert.equal(await page.locator("#reportStage4 .report-downloads button").count(), 0);
    assert.match(await page.locator("#reportStage4").textContent(), /no longer available/);
    const final = await loadBoardState(context);
    assert.deepEqual(final.exports, original.exports);
    assert.deepEqual(await hashes(final.exports), bytes);
    assert.deepEqual(final.cards, original.cards);
    await other.close();
});

test("UX-003 late completed deletion receipt cannot clear a successor saved report or replay deletion", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t);
    await save(page);
    const old = (await loadBoardState(context)).exports.at(-1);
    await page.route("**/api/artifact-deletion/confirm", async route => {
        await route.fetch();
        await route.abort("failed");
    }, { times: 1 });
    const dialog = await deleteReport(page, old.bundleId);
    await dialog.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await (await revealStoredRefresh(page)).click();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await openReportCreation(page);
    await page.getByRole("button", { name: "Start a new report", exact: true }).click();
    await save(page);
    const successor = (await loadBoardState(context)).exports.at(-1);
    await page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click();
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "saved");
    assert.equal(await page.locator("#reportStage4 .report-saved-id").textContent(), successor.bundleId);
    assert.ok(await page.locator("#reportStage4 .report-downloads button").count());
    assert.equal(requests.filter(value => value === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(requests.filter(value => value === "/api/artifact-deletion/status").length, 1);
});

test("UX-003 a delayed export receipt cannot claim a report deleted before the receipt arrived", { timeout: 60000 }, async t => {
    const { page, context, runtime } = await setup(t);
    let entered, release;
    const pending = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/export", async route => {
        const response = await route.fetch();
        entered(); await held; await route.fulfill({ response });
    }, { times: 1 });
    await chooseReportScope(page, "all"); await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await pending;
    const saved = (await loadBoardState(context)).exports.at(-1);
    const other = await page.context().newPage();
    await other.goto(runtime.url + "#reports"); await other.locator('#workspace[aria-busy="false"]').waitFor();
    const dialog = await deleteReport(other, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    release();
    await page.locator("#reportsView[data-report-phase=unavailable]").waitFor();
    assert.equal(await page.locator("#reportStage4 .report-save-success,#reportStage4 .report-downloads button").count(), 0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await other.close();
});

test("UX-003 an in-flight download is not dispatched after the displayed target is deleted", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t);
    await save(page);
    const saved = (await loadBoardState(context)).exports.at(-1);
    let entered, release;
    const pending = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/report-file", async route => {
        const response = await route.fetch();
        entered(); await held; await route.fulfill({ response });
    }, { times: 1 });
    const downloads = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    await page.locator("#reportStage4").getByRole("button", { name: "Download product-report.html", exact: true }).click();
    await pending;
    const dialog = await deleteReport(page, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const response = page.waitForResponse(value => value.url().endsWith("/api/report-file"));
    release(); await response;
    await page.waitForTimeout(200);
    assert.deepEqual(downloads, [], "A stale file response cannot start a new browser download");
    assert.equal(await page.locator("#reportJourneyError:visible").count(), 0, "Late download errors cannot replace the target-deleted state");
});

test("UX-002 report/comparison labels preserve named actions, chooser eligibility and frozen comparison links", { timeout: 60000 }, async t => {
    const { page, context, controller } = await setup(t, 2);
    const sources = (await loadBoardState(context)).exports;
    const preview = await controller.previewComparison("synthetic-comparison", sources[0].bundleId, sources[1].bundleId, { formats: ["html", "json"] });
    await controller.reviewComparison("synthetic-comparison", preview.previewId, true);
    const comparison = (await controller.confirmComparison("synthetic-comparison", preview.previewId, true)).bundle;
    const bytes = await hashes([comparison]);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await history(page);
    const comparisonRow = page.locator("#bundleList details").first();
    assert.match(await comparisonRow.locator(":scope > summary").textContent(), /^Comparison.*HTML, JSON/);
    await comparisonRow.locator(":scope > summary").click();
    await comparisonRow.locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await page.locator("#comparisonWorkspace").getByRole("heading", { name: "Saved comparison", exact: true }).waitFor();
    const dialog = await deleteReport(page, sources[0].bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.deepEqual(await hashes([comparison]), bytes);
    const opened = await controller.openComparison("synthetic-comparison", comparison.bundleId);
    assert.deepEqual(opened.sources.map(source => source.available), [false, true]);
    await page.locator("#savedReportSearch").fill(sources[1].bundleId);
    await page.locator("#bundleList details > summary").click();
    await page.locator("#bundleList").getByRole("button", { name: "Compare saved reports", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#comparisonWorkspace select")?.options.length === 2);
    const options = await page.locator("#comparisonWorkspace select").first().locator("option").evaluateAll(nodes => nodes.map(node => node.value));
    assert.deepEqual(options.filter(Boolean), [sources[1].bundleId], "Comparison artifacts remain ineligible as report inputs");
});

test("UX-003 confirmed save with failed availability refresh stays explicit and is never replayed", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t);
    await chooseReportScope(page, "all"); await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic saved-list read unavailable" } }), { times: 1 });
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    assert.match(await page.locator("#reportJourneyError").textContent(), /save was confirmed.*availability could not be checked.*do not save it again/);
    assert.match(await page.locator("#message").textContent(), /use Retry without repeating the save/);
    assert.equal(await page.locator("#reportStage4 .report-save-success,#reportStage4 .report-downloads button").count(), 0);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.equal(requests.filter(value => value === "/api/export").length, 1);
    const refresh = await revealStoredRefresh(page);
    assert.equal(await refresh.innerText(), "Retry");
    assert.equal(await refresh.isEnabled(), true);
    await refresh.click();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(requests.filter(value => value === "/api/export").length, 1);
});
