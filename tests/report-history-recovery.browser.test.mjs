import { historicalComparison } from "./historical-comparison-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, selectActivityOption } from "./helpers.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashes = async entries => Promise.all(entries.map(async entry => [
    entry.bundleId, await Promise.all(Object.entries(entry.files).map(async ([name, file]) => [name, digest(await readFile(file))])),
]));

async function setup(t, savedCount = 0) {
    const cleanup = [], releases = [];
    let runtime, browser;
    t.after(async () => {
        await Promise.all(releases.map(release => release()));
        try { await browser?.close(); }
        finally { try { await runtime?.close(); } finally { for (const remove of cleanup) await remove(); } }
    });
    const record = fixture();
    record.toolCalls[0].startedAt = record.capturedAt = new Date().toISOString();
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [record]);
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
    runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 1200, height: 960 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(new URL("/reports", runtime.url).href);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { context, page, errors, runtime, requests, controller, releases };
}

const button = (owner, name) => owner.getByRole("button", { name, exact: true });
const drawer = page => page.locator("#reportPreviewDrawer[open]");
const saveButton = page => button(drawer(page), "Save report");
const rows = page => page.locator("#bundleList .saved-library-row");
const inspect = row => button(row, "Inspect details");
const sections = page => page.getByRole("navigation", { name: "Report sections" });

async function overview(page) {
    if (await drawer(page).isVisible()) await drawer(page).getByRole("link", { name: "Back to Reports" }).click();
    await sections(page).getByRole("link", { name: "Overview", exact: true }).click();
}
async function previewAfter(page, action) {
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/preview")), action()]);
    const preview = await response.json();
    assert.equal(response.status(), 200, preview.error);
    await expect(saveButton(page)).toBeEnabled();
    return preview;
}
async function prepare(page) {
    await overview(page);
    return previewAfter(page, () => page.locator("#prepareReportPreview").click());
}
async function save(page) {
    const preview = await prepare(page);
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/export")), saveButton(page).click()]);
    const { bundle, error } = await response.json();
    assert.equal(response.status(), 200, error);
    assert.equal(bundle.privacyReview.reviewerConfirmed, false);
    assert.equal(bundle.privacyReview.localSave.contentHash, preview.localSaveRequest.contentHash);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    return bundle;
}
async function history(page) {
    if (await drawer(page).isVisible()) await drawer(page).getByRole("link", { name: "Back to Reports" }).click();
    await sections(page).getByRole("link", { name: "Saved library", exact: true }).click();
    await expect(page.locator("#savedReportSearch")).toBeVisible();
}
async function deleteReport(page, id) {
    await history(page);
    await page.locator("#savedReportSearch").fill(id);
    const target = page.locator(`#bundleList [data-bundle-id="${id}"]`);
    await button(target, "Delete report").click();
    const dialog = page.locator("dialog[open]").filter({ has: page.locator("#savedArtifactDeleteTitle") });
    await expect(dialog.locator(".decision-object")).toHaveText(await target.locator(".saved-report-name").innerText());
    await dialog.getByRole("button", { name: "Delete report", exact: true }).click();
    return dialog;
}

// Stop after the real server has acted, before the browser learns the result.
// Teardown drains an entered handler; a route that never matched has nothing to drain.
async function holdResponse(page, endpoint, releases) {
    const held = Promise.withResolvers(), finished = Promise.withResolvers();
    let entered = false, status;
    const release = async () => { held.resolve(); if (entered) await finished.promise; };
    releases.push(release);
    await page.route("**" + endpoint, async route => {
        entered = true;
        try {
            const response = await route.fetch({ timeout: 8000 });
            status = response.status();
            await held.promise;
            await route.fulfill({ response });
        } finally { finished.resolve(); }
    }, { times: 1 });
    return { wait: () => expect.poll(() => status, { message: `Waiting for real ${endpoint} response` }).toBe(200), release };
}

test("UX-001 typing stays local; updating or omitting a report copy never edits the original or saves files", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t);
    const preview = await prepare(page);
    await selectActivityOption(page, "preparedReportView", "text");
    const copy = page.locator(".prompt-comparison");
    const key = await copy.getAttribute("data-copy-key");
    const original = preview.promptReview.find(p => p.key === key).original;
    assert.equal(original, fixture().userPrompt.text);
    const edit = copy.getByText("Edit or omit this report copy", { exact: true });
    await edit.click();
    const editor = copy.getByRole("textbox");
    await editor.fill("Artificial revised report copy");
    await editor.press("End");
    await editor.pressSequentially(" keeps focus");
    assert.equal(await editor.evaluate(node => document.activeElement === node && node.selectionStart === node.value.length), true);
    assert.equal(requests.filter(path => path === "/api/preview").length, 1, "No per-keystroke regeneration");
    await expect(page.locator("#reportJourneyError:visible,.rebuild-preview:visible")).toHaveCount(0);
    const update = () => previewAfter(page, () => button(copy, "Update report copy").click());
    const revised = (await update()).promptReview.find(p => p.key === key);
    assert.equal(revised.text, "Artificial revised report copy keeps focus");
    assert.equal(revised.original, original);
    await edit.click();
    await copy.getByRole("checkbox", { name: /Omit this/ }).check();
    const omitted = (await update()).promptReview.find(p => p.key === key);
    assert.equal(omitted.omitted, true);
    assert.equal(omitted.text, null);
    await button(copy, "Local original").click();
    await expect(copy.locator(".prompt-original pre")).toHaveText(original);
    assert.equal((await loadBoardState(context)).evidence[0].userPrompt.text, original);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(value => value === "/api/export").length, 0);
});

test("UX-002 seventh actual saved report is descriptive and on first history page", { timeout: 90000 }, async t => {
    const { page, context } = await setup(t, 6);
    const before = await loadBoardState(context), bytes = await hashes(before.exports);
    await save(page);
    const state = await loadBoardState(context), newest = state.exports.at(-1);
    assert.equal(state.exports.length, 7);
    await history(page);
    const summaries = await rows(page).locator(".saved-report-title").allTextContents();
    assert.equal(summaries.length, 6);
    assert.ok(summaries[0].startsWith(newest.title));
    await button(rows(page).first(), "Files for " + newest.title).click();
    await expect(button(page.locator(".saved-report-menu:popover-open"), "Web page (HTML)")).toBeVisible();
    await page.keyboard.press("Escape");
    assert.doesNotMatch(summaries[0], /Masked prompts/);
    await inspect(rows(page).first()).click();
    assert.equal(await page.locator("#bundleList .saved-library-row").first().getAttribute("data-bundle-id"), newest.bundleId, "Newest report is the first row");
    assert.equal(await page.locator("#contextSidebarTitle").textContent(), newest.title);
    assert.deepEqual(state.exports.slice(0, 6), before.exports, "Presentation sorting cannot reorder or rewrite the persisted index");
    assert.deepEqual(await hashes(state.exports.slice(0, 6)), bytes, "Old artifact bytes remain frozen");
    const first = page.locator("#bundleList .saved-library-row").first();
    assert.match(await page.locator(".saved-inspector-facts").textContent(), /Interactions:?\s*1/i, "Exact membership remains in the details");
    await page.locator("#closeContextSidebar").focus();
    await page.keyboard.press("Enter");
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await expect(inspect(first)).toBeFocused();
    await page.evaluate(() => {
        window.savedReopenFocus = [];
        document.querySelector("#contextSidebar").addEventListener("focusin", event => window.savedReopenFocus.push(event.target.id));
    });

    await page.keyboard.press("Space");
    await page.locator("#contextSidebar[open]").waitFor();
    assert.equal(await page.locator("#savedInspectorTitle").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.savedReopenFocus), ["savedInspectorTitle"],
        "Native dialog entry must not visit Close and leave its unrelated help over the heading");
    assert.equal(await page.locator(".ux-tooltip:not([hidden])").count(), 0);
    await page.keyboard.press("Escape");
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await page.locator("#savedReportSearch").fill(before.exports[0].bundleId);
    assert.equal(await page.locator("#bundleList .saved-library-row").count(), 1, "Search filters all rows before pagination");
    assert.equal(await page.locator("#bundleList .saved-library-row").getAttribute("data-bundle-id"), before.exports[0].bundleId);
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
        const dimensions = await rows(page).locator(".saved-report-title").evaluateAll(nodes => nodes.map(node => ({
            height: node.getBoundingClientRect().height, clipped: node.scrollWidth > node.clientWidth + 1,
        })));
        assert.ok(dimensions.length && dimensions.every(row => row.height >= 44 && !row.clipped), `${theme}/${width}/${size}: readable 44px summaries`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${size}: no page overflow`);
        if (process.env.WIRE_REPORT_UX_PROOFS && width === 375 && size === "200%") {
            await mkdir(process.env.WIRE_REPORT_UX_PROOFS, { recursive: true });
            await page.locator("#bundleList .saved-library-row").first().screenshot({ path: path.join(process.env.WIRE_REPORT_UX_PROOFS, `history-${theme}-${width}-${size}.png`) });
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#savedReportSearch").fill("masked");
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await save(page);
    const next = (await loadBoardState(context)).exports.at(-1);
    await history(page);
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "masked", "Explicit saves keep the history query");
    assert.match(await page.locator("#bundleList").textContent(), /1-6 of 8 saved reports/);
    assert.equal(await page.locator("#bundleList .saved-library-row").first().getAttribute("data-view-key"), "bundle:" + next.bundleId, "Explicit save returns only the active history page to the top");
});

test("saved title owns native entry while current tooltip and select keep first Escape priority", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t, 2);
    const before = await loadBoardState(context), bytes = await hashes(before.exports), evidence = [];
    await history(page);
    await page.evaluate(() => {
        window.savedEntryFocus = [];
        document.querySelector("#contextSidebar").addEventListener("focusin", event => window.savedEntryFocus.push(event.target.id));
    });
    for (const [width, textSize] of [[1440, "100%"], [600, "100%"], [1440, "200%"]]) {
        await page.setViewportSize({ width, height: 960 });
        await page.evaluate(value => document.documentElement.style.fontSize = value, textSize);
        const first = inspect(rows(page).first());
        async function open() {
            await first.focus();
            await page.evaluate(() => { window.savedEntryFocus = []; });
            await page.keyboard.press("Space");
            await page.locator("#contextSidebar[open]").waitFor();
            assert.deepEqual(await page.evaluate(() => window.savedEntryFocus), ["savedInspectorTitle"]);
            assert.equal(await page.locator(".ux-tooltip:not([hidden])").count(), 0, "Native opening never exposes accidental Close help");
        }
        await open();
        const panel = page.locator("#contextSidebar"), close = page.locator("#closeContextSidebar");
        const modal = await panel.evaluate(node => node.matches(":modal"));
        assert.equal(modal, width === 600 || textSize === "200%");
        await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
        await page.keyboard.press("Shift+Tab");
        await expect(close).toBeFocused();
        await page.getByRole("tooltip", { name: "Close saved report details", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await panel.evaluate(node => node.open), true, "First Escape dismisses genuine focused Close help only");
        assert.equal(await close.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator(".ux-tooltip:not([hidden])").count(), 0);
        await page.keyboard.press("Enter");
        await panel.waitFor({ state: "hidden" });
        assert.equal(await first.evaluate(node => node === document.activeElement), true);

        await open();
        await close.hover();
        await page.getByRole("tooltip", { name: "Close saved report details", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await panel.evaluate(node => node.open), true, "Genuine pointer help retains its first-Escape dismissal");
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(await first.evaluate(node => node === document.activeElement), true);

        await open();
        const select = panel.getByRole("combobox", { name: "Saved file", exact: true });
        await select.click();
        await page.getByRole("option", { name: "Structured data (JSON)", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await panel.evaluate(node => node.open), true, "A live nested popup, not the outer dialog, owns first Escape");
        assert.equal(await select.evaluate(node => node.getAttribute("aria-expanded")), "false");
        assert.equal(await select.evaluate(node => node === document.activeElement), true);
        await page.locator("#savedInspectorTitle").focus();
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(await first.evaluate(node => node === document.activeElement), true);
        evidence.push({ width, textSize, modal, nativeFocus: await page.evaluate(() => window.savedEntryFocus) });
    }
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    assert.deepEqual(await hashes(before.exports), bytes);
    if (process.env.WIRE_REPORT_UX_PROOFS) {
        await mkdir(process.env.WIRE_REPORT_UX_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_REPORT_UX_PROOFS, "saved-native-escape.json"), JSON.stringify(evidence, null, 2));
    }
});

test("saved native autofocus does not steal newer focus after replacement, refresh or departure", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t, 2);
    const before = await loadBoardState(context), bytes = await hashes(before.exports);
    await history(page);
    const panel = page.locator("#contextSidebar");
    await inspect(rows(page).first()).click();
    const replacement = await page.evaluate(async () => {
        document.querySelectorAll("#bundleList [data-view-key^='inspect-bundle:']")[1].click();
        const heading = document.querySelector("#savedInspectorTitle");
        const initial = document.activeElement.id;
        document.querySelector("#closeContextSidebar").focus();
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (let i = 0; i < 120; i++) {
            await frame();
            if (i > 2 && !document.querySelector("#contextSidebar").getAnimations().length) break;
        }
        return { initial, focus: document.activeElement.id, headingCurrent: heading.isConnected,
            autofocus: heading.autofocus, headings: document.querySelectorAll("#savedInspectorTitle").length };
    });
    assert.deepEqual(replacement, { initial: "savedInspectorTitle", focus: "closeContextSidebar", headingCurrent: true, autofocus: true, headings: 1 });

    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        for (const saved of data.exports || []) saved.preparedAtDisplay = "Synthetic refreshed display date";
        await route.fulfill({ response, json: data });
    });
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await refreshed;
    await page.locator(".saved-inspector-facts").getByText("Synthetic refreshed display date", { exact: true }).waitFor();
    const refreshFocus = await page.locator("#closeContextSidebar").evaluate(async node => {
        node.focus();
        const visits = [], listener = event => visits.push(event.target.id);
        document.addEventListener("focusin", listener);
        for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
        document.removeEventListener("focusin", listener);
        return { focus: document.activeElement.id, visits };
    });
    assert.deepEqual(refreshFocus, { focus: "closeContextSidebar", visits: [] }, "Inserted autofocus is not a later focus command in an already-open inspector");
    await page.unroute("**/api/snapshot");

    await panel.getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader").waitFor();
    await panel.waitFor({ state: "hidden" });
    await page.locator("#savedReportReader").getByRole("button", { name: "Back to saved reports", exact: true }).click();
    await page.locator("#savedInspectorTitle").waitFor();
    const restoredAction = panel.getByRole("button", { name: "Open saved report", exact: true });
    assert.equal(await restoredAction.evaluate(node => node === document.activeElement), true, "Reader return keeps the existing action-focus contract");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await prepare(page);
    const title = drawer(page).getByLabel("Report name", { exact: true });
    await title.focus();
    await expect(title).toBeFocused();
    await expect(panel).toBeHidden();
    await expect(page.locator("#savedInspectorTitle")).toHaveCount(0);
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    assert.deepEqual(await hashes(before.exports), bytes);
});

test("UX-003 deleting the displayed saved report removes its ready result", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t);
    const saved = await save(page);
    const dialog = await deleteReport(page, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(await page.locator("#reportStage3 .report-save-success").count(), 0, "A deleted report must not still be claimed ready");
    assert.equal(await page.locator("#reportStage3 .report-downloads button").count(), 0, "A deleted report has no download controls");
});

test("UX-001 changing contents blocks stale Save; keeping chat details requires a choice for the updated files", { timeout: 60000 }, async t => {
    const { page, context, requests, releases } = await setup(t);
    // Refuse an empty deliberate selection instead of silently preparing all activity.
    const activity = page.locator("#reportDeskActivity");
    await activity.click();
    await page.locator("[name=reportScope][value=selected]").check();
    await button(page.locator("#reportActivityOptions"), "Use activity").click();
    await expect(page.locator("#prepareReportPreview")).toBeDisabled();
    assert.equal(requests.includes("/api/preview"), false);
    await activity.click();
    await page.locator("[name=reportScope][value=all]").check();
    await button(page.locator("#reportActivityOptions"), "Use activity").click();
    const first = await prepare(page);
    await drawer(page).getByRole("button", { name: /^Report text:/ }).click();
    const held = await holdResponse(page, "/api/preview", releases);
    await page.locator("[name=promptMode][value=original]").check();
    await held.wait();
    await expect(drawer(page)).toContainText("Updating the report. Save is unavailable.");
    await expect(saveButton(page)).toBeHidden();
    await expect(button(page, "Rebuild preview")).toHaveCount(0);
    await held.release();
    await expect(saveButton(page)).toBeEnabled();
    await page.keyboard.press("Escape");
    await drawer(page).getByRole("button", { name: /^Formats:/ }).click();
    const updated = await previewAfter(page, () => page.locator("#formatOptions input[value=json]").check());
    assert.notEqual(updated.previewId, first.previewId);
    await page.keyboard.press("Escape");
    await saveButton(page).click();
    const warning = page.getByRole("dialog").filter({ has: button(page, "Save with chat details") });
    await expect(warning).toContainText(/HTML/);
    await expect(warning).toContainText(/JSON/);
    await button(warning, "Go back").click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(value => value === "/api/export").length, 0);
    await saveButton(page).click();
    await button(warning, "Save with chat details").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const [entry] = (await loadBoardState(context)).exports;
    assert.equal(entry.privacyReview.localSave.contentHash, updated.localSaveRequest.contentHash);
    assert.equal(entry.privacyReview.localSave.keepChatDetailsConfirmed, true);
    assert.equal(entry.privacyReview.reviewerConfirmed, false);
    assert.equal(await readFile(entry.files["product-report.json"], "utf8"), updated.files["product-report.json"]);
    assert.equal(requests.filter(value => value === "/api/export").length, 1);
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
    const ids = await page.locator("#bundleList .saved-library-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey));
    assert.deepEqual(ids, [5, 4, 3, 2, 0, 1].map(index => "bundle:" + registered.exports[index].bundleId), "Exact timestamp ties use reverse registration order; missing dates remain stable at the end");
    const labels = await rows(page).locator(".saved-report-title").allTextContents();
    assert.ok(labels[4].startsWith(registered.exports[0].title), "A retained title survives missing optional metadata");
    assert.doesNotMatch(labels[4], /Prepared |Invalid Date/);
    assert.doesNotMatch(labels[4], /Masked|Original|request group/);
    await rows(page).nth(4).locator(".saved-report-files").click();
    const files = page.locator(".saved-report-menu:popover-open");
    await expect(button(files, "Web page (HTML)")).toBeVisible();
    await expect(button(files, "Structured data (JSON)")).toBeVisible();
    await page.keyboard.press("Escape");
    assert.doesNotMatch(labels[5], /Prepared |Invalid Date/);
    assert.match(labels[3], /jeudi 1 octobre/);
    await page.locator("#savedReportSearch").fill("[");
    assert.match(await page.locator("#bundleList").textContent(), /No saved reports match/, "Search is literal, not a regex");
    await page.locator("#savedReportSearch").fill(registered.exports[0].bundleId);
    await inspect(rows(page)).click();
    assert.equal(await page.locator("#contextSidebarTitle").textContent(), registered.exports[0].title);
    assert.deepEqual((await loadBoardState(context)).exports, registered.exports);
    assert.deepEqual(await hashes(registered.exports), frozen);

    // A genuine unanchored v3 file, not a verified bundle with its hash removed.
    const bundleId = "export-" + randomUUID(), bundleDir = path.join(context.dataDir, "exports", bundleId, "files");
    const title = "Archived local original", html = "<!doctype html><title>Archived</title><h1>Frozen archived wording</h1>";
    const entry = { kind: "report", bundleId, bundleDir, title, formats: ["html"], promptMode: "none",
        privacyReview: { reviewerConfirmed: true }, files: Object.fromEntries(["product-report.html", "coverage-and-redaction-manifest.json"]
            .map(name => [name, path.join(bundleDir, name)])) };
    const snapshot = { schemaVersion: 3, bundleId, formats: entry.formats, promptMode: entry.promptMode, records: [] };
    await mkdir(bundleDir, { recursive: true });
    await writeFile(entry.files["product-report.html"], html);
    await writeFile(entry.files["coverage-and-redaction-manifest.json"], JSON.stringify({
        schemaVersion: 3, bundleId, formats: entry.formats, promptMode: entry.promptMode, privacyReview: entry.privacyReview,
        snapshotHash: digest(JSON.stringify(snapshot)), files: { "product-report.html": { bytes: Buffer.byteLength(html), sha256: digest(html) } },
    }));
    await updateBoardState(context, state => { state.exports.push(entry); });
    const beforeOpen = (await loadBoardState(context)).exports, bytes = await hashes(beforeOpen);
    await page.goto(new URL("/reports", page.url()).href);
    await history(page);
    await page.locator("#savedReportSearch").fill(bundleId);
    await rows(page).locator(".saved-report-title").click();
    await expect(page.locator("#savedOriginalNotice")).toContainText("can't confirm the privacy review");
    await expect(page.locator("#savedReportReader iframe")).toHaveCount(0);
    const [original] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/report-original")), button(page, "Open original file").click()]);
    const read = await original.json();
    assert.equal(read.verification, "unverified");
    assert.equal(read.artifact.bundleId, bundleId);
    assert.deepEqual(Buffer.from(read.data, "base64"), Buffer.from(html));
    await expect(page.frameLocator("#savedReportReader iframe").getByRole("heading")).toHaveText("Frozen archived wording");
    assert.deepEqual((await loadBoardState(context)).exports, beforeOpen);
    assert.deepEqual(await hashes(beforeOpen), bytes);
});

test("UX-003 cross-tab named deletion invalidates only the displayed target through normal polling", { timeout: 60000 }, async t => {
    const { page, context, runtime } = await setup(t, 1);
    const original = await loadBoardState(context), bytes = await hashes(original.exports);
    await save(page);
    const saved = (await loadBoardState(context)).exports.at(-1);
    const other = await page.context().newPage();
    await other.goto(new URL("/reports", runtime.url).href);
    await other.locator('#workspace[aria-busy="false"]').waitFor();
    const dialog = await deleteReport(other, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=unavailable]").waitFor({ timeout: 15000 });
    assert.equal(await page.locator("#reportStage3 .report-downloads button").count(), 0);
    assert.match(await page.locator("#reportStage3").textContent(), /no longer available/);
    const final = await loadBoardState(context);
    assert.deepEqual(final.exports, original.exports);
    assert.deepEqual(await hashes(final.exports), bytes);
    assert.deepEqual(final.evidence, original.evidence);
    await other.close();
});

test("UX-003 late completed deletion receipt cannot clear a successor saved report or replay deletion", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t);
    await save(page);
    const old = (await loadBoardState(context)).exports.at(-1);
    let confirmed;
    await page.route("**/api/artifact-deletion/confirm", async route => {
        confirmed = route.request().postDataJSON();
        await route.fetch();
        await route.abort("failed");
    }, { times: 1 });
    const [decision, dialog] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/artifact-deletion/preview")),
        deleteReport(page, old.bundleId)]);
    const original = await decision.json();
    assert.equal(original.artifact.artifactId, old.bundleId);
    assert.equal(original.operationId, confirmed.operationId);
    await dialog.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(rows(page)).toHaveCount(0, { timeout: 15000 });
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await save(page);
    const successor = (await loadBoardState(context)).exports.at(-1);
    assert.notEqual(successor.bundleId, old.bundleId);
    const bytes = await hashes([successor]);
    const [status] = await Promise.all([page.waitForRequest(r => r.url().endsWith("/api/artifact-deletion/status")),
        button(page, "Check earlier saved-item deletion").click()]);
    assert.equal(status.postDataJSON().operationId, confirmed.operationId);
    assert.ok(original.receiptToken);
    assert.equal(status.postDataJSON().receiptToken, original.receiptToken);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "saved");
    await expect(drawer(page)).toHaveAccessibleName("Report saved");
    assert.ok(await page.locator("#reportStage3 .report-downloads button").count());
    assert.equal(requests.filter(value => value === "/api/artifact-deletion/confirm").length, 1);
    assert.equal(requests.filter(value => value === "/api/artifact-deletion/status").length, 1);
    await button(drawer(page), "Open saved report").click();
    await expect(page.locator("#savedReportReader")).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("bundle"), successor.bundleId);
    assert.deepEqual(await hashes((await loadBoardState(context)).exports), bytes);
});

test("UX-003 a delayed export receipt cannot claim a report deleted before the receipt arrived", { timeout: 60000 }, async t => {
    const { page, context, runtime, releases, requests } = await setup(t);
    const preview = await prepare(page);
    const held = await holdResponse(page, "/api/export", releases);
    await saveButton(page).click();
    await held.wait();
    const saved = (await loadBoardState(context)).exports.at(-1);
    assert.equal(saved.bundleId, preview.bundleId);
    const other = await page.context().newPage();
    await other.goto(new URL("/reports", runtime.url).href); await other.locator('#workspace[aria-busy="false"]').waitFor();
    const dialog = await deleteReport(other, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await held.release();
    await page.locator("#reportsView[data-report-phase=unavailable]").waitFor();
    assert.equal(await page.locator("#reportStage3 .report-save-success,#reportStage3 .report-downloads button").count(), 0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(path => path === "/api/export").length, 1);
    await other.close();
});

test("UX-003 an in-flight download is not dispatched after the displayed target is deleted", { timeout: 60000 }, async t => {
    const { page, context, releases } = await setup(t);
    await save(page);
    const saved = (await loadBoardState(context)).exports.at(-1);
    const held = await holdResponse(page, "/api/artifact-file", releases);
    const downloads = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    await page.locator("#reportStage3").getByRole("button", { name: "Download", exact: true }).click();
    await held.wait();
    const dialog = await deleteReport(page, saved.bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const [response] = await Promise.all([page.waitForResponse(value => value.url().endsWith("/api/artifact-file")), held.release()]);
    await response.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(downloads, [], "A stale file response cannot start a new browser download");
    assert.equal(await page.locator("#reportJourneyError:visible").count(), 0, "Late download errors cannot replace the target-deleted state");
});

test("UX-002 report/comparison labels preserve named actions, chooser eligibility and frozen comparison links", { timeout: 60000 }, async t => {
    const { page, context, controller, requests } = await setup(t, 2);
    const sources = (await loadBoardState(context)).exports;
    const { bundle: comparison } = await historicalComparison(context, sources[0].bundleId, sources[1].bundleId, { formats: ["html", "json"] });
    const bytes = await hashes([comparison, sources[1]]);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await history(page);
    const comparisonRow = page.locator("#bundleList .saved-library-row").first();
    await expect(comparisonRow.locator(".saved-report-name")).toHaveText(comparison.title);
    await comparisonRow.locator(".saved-report-files").click();
    const menu = page.locator(".saved-report-menu:popover-open");
    await expect(button(menu, "Structured data (JSON)")).toBeVisible();
    const [file] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/artifact-file")), button(menu, "Web page (HTML)").click()]);
    const value = await file.json();
    assert.equal(value.artifact.bundleId, comparison.bundleId);
    assert.equal(value.manifestHash, comparison.manifestHash);
    assert.deepEqual(Buffer.from(value.data, "base64"), await readFile(comparison.files["comparison-report.html"]));
    await page.locator("#savedReportReader").waitFor({ state: "visible" });
    assert.equal(await page.locator("#pageTitle").textContent(), comparison.title);
    await button(page, "Back to saved reports").click();
    const dialog = await deleteReport(page, sources[0].bundleId);
    await dialog.getByRole("heading", { name: "Saved report deleted", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    assert.deepEqual(await hashes([comparison, sources[1]]), bytes);
    const opened = await controller.openComparison("synthetic-comparison", comparison.bundleId);
    assert.deepEqual(opened.sources.map(source => source.available), [false, true]);
    await page.locator("#savedReportSearch").fill(sources[1].bundleId);
    assert.equal(await page.getByRole("link", { name: "Compare saved reports" }).count(), 0);
    // Changing this disposable file must produce a verified-read refusal, never an original-file fallback.
    const filePath = sources[1].files["product-report.html"];
    await writeFile(filePath, Buffer.concat([await readFile(filePath), Buffer.from("altered")]));
    await rows(page).locator(".saved-report-files").click();
    await button(menu, "Web page (HTML)").click();
    await expect(page.locator("#savedReportReader [role=alert]")).toContainText(/changed|verif|integrity/i);
    await expect(page.locator("#savedReportReader iframe")).toHaveCount(0);
    assert.equal(requests.includes("/api/report-original"), false);
    assert.deepEqual(await hashes([comparison]), bytes.slice(0, 1));
});

test("UX-003 confirmed save with failed availability refresh stays explicit and is never replayed", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t);
    const preview = await prepare(page);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic saved-list read unavailable" } }), { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    assert.match(await page.locator("#reportJourneyError").textContent(), /save was confirmed.*availability could not be checked.*do not save it again/);
    assert.match(await page.locator("#message").textContent(), /use Retry without repeating the save/);
    assert.equal(await page.locator("#reportStage3 .report-save-success,#reportStage3 .report-downloads button").count(), 0);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.equal(requests.filter(value => value === "/api/export").length, 1);
    const bytes = await hashes((await loadBoardState(context)).exports);
    const [read] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/snapshot")), button(page, "Check save status").click()]);
    const [receipt] = (await read.json()).exports;
    assert.equal(receipt.bundleId, preview.bundleId);
    assert.equal(receipt.privacyReview.localSave.contentHash, preview.localSaveRequest.contentHash);
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    assert.equal(requests.filter(value => value === "/api/export").length, 1);
    assert.deepEqual(await hashes((await loadBoardState(context)).exports), bytes);
});
