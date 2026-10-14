import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { navigateMain, navigateSettings, chooseTheme } from "./helpers.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { deletionHash } from "../lib/deletion-identities.mjs";
import path from "node:path";
import { chooseReportScope, reportContents, scanReport } from "./report-journey-helpers.mjs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { time } from "../lib/time.mjs";

async function capture(page, name) {
    if (!process.env.WIRE_RECOLLECTION_PROOF_DIR) return;
    await mkdir(process.env.WIRE_RECOLLECTION_PROOF_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WIRE_RECOLLECTION_PROOF_DIR, `${name}.png`) });
}
async function visibleHeaderExit(page) {
    const box = await page.locator("#recollectClose").evaluate(button => {
        const rect = button.getBoundingClientRect();
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { top: rect.top, bottom: rect.bottom, height: innerHeight, reachable: button === point || button.contains(point),
            header: button.parentElement.classList.contains("dialog-head") };
    });
    assert.ok(box.header && box.top >= 0 && box.bottom <= box.height && box.reachable, JSON.stringify(box));
}
async function chooseScope(page, f, prompts = false) {
    await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
    await page.locator("#recollectFrom").fill(f.firstDay);
    await page.locator("#recollectTo").fill(f.firstDay);
    if (prompts) await page.locator("#recollectPrompts").check();
}
async function previewScope(page, f, prompts = false) {
    await chooseScope(page, f, prompts);
    await page.locator("#recollectPreview").click();
    await page.locator("#recollectConfirmation").waitFor({ state: "visible" });
}
async function setup(t) {
    const f = await recollectionFixture(t);
    const deletion = createDeletionController(f.context);
    const all = await deletion.preview("fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("fixture", { operationId: all.operationId, confirmed: true });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.goto(f.runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(page, "settings"); await navigateSettings(page, "data");
    return { f, page };
}

test("deleted source activity stays absent until an explicit source-backed recollection", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC" });
    page.setDefaultTimeout(7000);
    await page.goto(f.runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(page, "settings");
    await navigateSettings(page, "data");
    await page.locator("#deleteActivity").click();
    await page.locator("#deleteAll").check();
    await page.locator("#deletePreview").click();
    await page.locator("#deleteConfirmation").waitFor({ state: "visible" });
    await page.locator("#deleteConfirm").click();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    await page.locator("#deleteCancel").click();
    assert.deepEqual((await loadBoardState(f.context)).evidence, []);
    await f.collector.collectNow();
    assert.deepEqual((await loadBoardState(f.context)).evidence, []);
    assert.equal(await page.getByRole("button", { name: "Recollect from approved sources", exact: true }).count(), 1,
        "Deleting to empty needs an explicit in-app source-backed recollection, not a test reset");
    const sourceHashes = await Promise.all([...f.files, f.dbPath].map(async file => deletionHash(await readFile(file))));
    const before = await loadBoardState(f.context);
    await page.locator("#recollectActivity").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "recollectClose");
    assert.equal(await page.locator("#recollectPrompts").isChecked(), false);
    await chooseScope(page, f, true);
    await capture(page, "recollection-scope");
    await previewScope(page, f, true);
    assert.match(await page.locator("#recollectSummary").innerText(), /1 previously deleted/);
    assert.match(await page.locator("#recollectPromptSummary").innerText(), /Restore 1 original prompt/);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement.id), "recollectActivity");
    assert.deepEqual(await loadBoardState(f.context), before);
    await page.locator("#recollectActivity").click();
    assert.equal(await page.locator("#recollectPrompts").isChecked(), false);
    await previewScope(page, f, true);
    await page.locator("#recollectChange").click();
    assert.equal(await page.locator("#recollectConfirm").isVisible(), false);
    await page.locator("#recollectPreview").click();
    await page.locator("#recollectConfirmation").waitFor({ state: "visible" });
    await page.locator("#recollectConfirm").click();
    await page.waitForFunction(() => document.querySelector("#recollectTitle").textContent === "Evidence recollected");
    await capture(page, "recollection-complete");
    const result = await loadBoardState(f.context);
    assert.deepEqual(result.evidence.flatMap(row => row.toolCalls.map(call => call.toolCallId)), ["selected-A"]);
    assert.equal(result.evidence[0].userPrompt.text, "Synthetic request selected-A");
    await page.locator("#recollectClose").click();
    await page.reload(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await f.collector.collectNow();
    assert.deepEqual((await loadBoardState(f.context)).evidence.flatMap(row => row.toolCalls.map(call => call.toolCallId)), ["selected-A"]);
    await navigateMain(page, "reports");
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator("[name=promptMode][value=original]").check();
    const report = await scanReport(page);
    assert.equal(report.records.flatMap(row => row.toolCalls).length, 1);
    await page.frameLocator(".report-frame").locator("h1").waitFor();
    assert.match(await page.frameLocator(".report-frame").locator("body").textContent(), /Synthetic request selected-A/);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await page.getByRole("button", { name: "Save report locally", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    await capture(page, "recollection-new-report-saved");
    assert.equal((await loadBoardState(f.context)).exports.length, 1);
    assert.deepEqual(await Promise.all([...f.files, f.dbPath].map(async file => deletionHash(await readFile(file)))), sourceHashes);
});

test("pending and lost recollection response recover by receipt after reload, never resending", { timeout: 30000 }, async t => {
    const { f, page } = await setup(t);
    await page.locator("#recollectActivity").click();
    await previewScope(page, f);
    let commits = 0, committedId, receiptId, cancellations = 0, release;
    page.on("request", request => { if (request.url().endsWith("/api/recollection/cancel")) cancellations++; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/recollection/confirm", async route => {
        commits++; committedId = route.request().postDataJSON().operationId;
        await route.fetch(); await held; await route.abort("failed");
    });
    await page.locator("#recollectConfirm").click();
    await page.waitForFunction(() => document.querySelector("#recollectStatus").textContent.includes("Re-reading"));
    assert.equal(await page.locator("#recollectClose").isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#recollectDialog").isVisible(), true);
    await capture(page, "recollection-pending");
    release();
    await page.locator("#recollectCheck").waitFor({ state: "visible" });
    await capture(page, "recollection-uncertain");
    await page.reload(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(page, "settings"); await navigateSettings(page, "data");
    await page.locator("#recollectActivity").click();
    let releaseRead;
    const heldRead = new Promise(resolve => { releaseRead = resolve; });
    let reads = 0;
    await page.route("**/api/recollection/status", async route => {
        reads++;
        receiptId = route.request().postDataJSON().operationId;
        const response = await route.fetch();
        await heldRead;
        await route.fulfill({ response });
    });
    await page.locator("#recollectCheck").click();
    await page.waitForFunction(() => document.querySelector("#recollectCheck").disabled);
    await visibleHeaderExit(page);
    assert.equal(await page.locator("#recollectClose").isEnabled(), true);
    await page.locator("#recollectClose").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "recollectActivity");
    releaseRead();
    await page.waitForFunction(() => !sessionStorage.getItem("workiq-evidence.recollection-operation"));
    assert.equal(await page.locator("#recollectDialog").isVisible(), false, "A late receipt does not reopen a dismissed read");
    assert.equal(commits, 1);
    assert.equal(reads, 1);
    assert.equal(receiptId, committedId);
    assert.equal(cancellations, 0, "Closing a receipt read never cancels or replays the committed action");
    assert.equal((await loadBoardState(f.context)).evidence.length, 1);
});

test("source changes and missing history have readable non-success states", { timeout: 30000 }, async t => {
    const { f, page } = await setup(t);
    await page.locator("#recollectActivity").click();
    await previewScope(page, f);
    await appendFile(f.files[0], "\n");
    await page.locator("#recollectConfirm").click();
    await page.locator("#recollectCheck").waitFor({ state: "visible" });
    await capture(page, "recollection-stale-source");
    await page.locator("#recollectCheck").click();
    await page.waitForFunction(() => document.querySelector("#recollectStatus").textContent.includes("No committed recollection"));
    assert.deepEqual((await loadBoardState(f.context)).evidence, []);
    await page.locator("#recollectClose").click();
    await rename(f.files[0], f.files[0] + ".missing");
    await page.locator("#recollectActivity").click();
    await page.getByText("Recollection selected chat - history unavailable", { exact: true }).waitFor();
    await previewScope(page, f);
    await page.getByText("Source availability and limits", { exact: true }).click();
    assert.match(await page.locator("#recollectAvailability").innerText(), /unavailable/);
    assert.equal(await page.locator("#recollectConfirm").isDisabled(), true);
    await capture(page, "recollection-unavailable");
    await page.locator("#recollectClose").click();
    assert.deepEqual((await loadBoardState(f.context)).evidence, []);
});

test("recollection confirmation is readable in light/navy, narrow/large text, with keyboard focus and safe Close", { timeout: 30000 }, async t => {
    const { f, page } = await setup(t);
    const proofDir = process.env.WIRE_RECOLLECTION_PROOF_DIR;
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "navy"]) {
        await chooseTheme(page, theme === "navy" ? "dark" : "light");
        for (const [width, fontSize] of [[1200, "16px"], [375, "16px"], [375, "32px"]]) {
            await page.setViewportSize({ width, height: 950 });
            await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
            await page.locator("#recollectActivity").click();
            await previewScope(page, f, true);
            const scopeText = await page.locator("#recollectScope").innerText();
            const date = time.formatDate(f.firstDay, { locale: "en-US", timeZone: "UTC" }, true);
            assert.equal(scopeText.split(date).length - 1, 1, "A single-day scope is named once");
            assert.doesNotMatch(await page.locator("#recollectDialog").innerText(), /T\d{2}:\d{2}|MiB|expires after|anonymous local-only/);
            const measurements = await page.locator("#recollectDialog").evaluate(dialog => ({
                client: dialog.clientWidth, scroll: dialog.scrollWidth, viewport: window.innerWidth,
                left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right,
                controls: [...dialog.querySelectorAll("button")].filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect().height),
            }));
            assert.ok(measurements.scroll <= measurements.client + 1, JSON.stringify(measurements));
            assert.ok(measurements.left >= 0 && measurements.right <= measurements.viewport);
            assert.ok(measurements.controls.every(height => height >= 44));
            const contrast = await page.locator("#recollectDialog").evaluate(dialog => {
                const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
                    const channel = n / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
                const background = luminance(getComputedStyle(dialog).backgroundColor);
                return [...dialog.querySelectorAll("p,summary,button")].filter(node => node.checkVisibility() && !node.disabled).map(node => {
                    const foreground = luminance(getComputedStyle(node).color);
                    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
                });
            });
            assert.ok(contrast.every(value => value >= 4.5), JSON.stringify({ theme, contrast }));
            assert.equal(await page.evaluate(() => document.activeElement.id), "recollectClose");
            await page.locator("#recollectConfirm").focus(); await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), "recollectClose");
            await page.keyboard.press("Shift+Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), "recollectConfirm");
            if (proofDir) {
                await page.locator("#recollectDialog").evaluate(dialog => { dialog.scrollTop = 0; });
                await page.screenshot({ path: path.join(proofDir, `recollection-${theme}-${width}-${fontSize}.png`) });
            }
            await page.locator("#recollectClose").click();
            assert.equal(await page.evaluate(() => document.activeElement.id), "recollectActivity");
            assert.deepEqual((await loadBoardState(f.context)).evidence, []);
        }
    }
});

test("940 real eligible chats use bounded local search/paging and preserve selections across navigation", { timeout: 30000 }, async t => {
    const { f, page } = await setup(t);
    const db = new DatabaseSync(f.dbPath);
    try {
        const insert = db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)");
        db.exec("BEGIN");
        for (let i = 1; i <= 938; i++) insert.run(randomUUID(), `Synthetic roster ${String(i).padStart(4, "0")}`, "chat", null, "local");
        db.exec("COMMIT");
    } finally { db.close(); }
    const before = await loadBoardState(f.context), sourceHash = deletionHash(await readFile(f.dbPath));
    const requests = [];
    page.on("request", request => { if (request.url().includes("/api/recollection/")) requests.push(request); });
    await page.locator("#recollectActivity").click();
    await page.locator("#recollectSources .list-pager").getByText("1-8 of 940 chats", { exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 680 });
    await visibleHeaderExit(page);
    await page.locator("#recollectDialog").evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight; });
    await visibleHeaderExit(page);
    await capture(page, "recollection-940-header-exit-scrolled");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#recollectDialog").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "recollectActivity");
    await page.locator("#recollectActivity").click();
    await page.locator("#recollectSources .list-pager").getByText("1-8 of 940 chats", { exact: true }).waitFor();
    requests.length = 0;
    assert.equal(await page.locator("#recollectSources input").count(), 8);
    assert.doesNotMatch(await page.locator("#recollectWindow").innerText(), /T\d{2}:\d{2}|\.\d{3}Z/);
    await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
    await page.getByRole("button", { name: "Next chats", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.locator("#recollectSources .list-pager").getByText("9-16 of 940 chats", { exact: true }).waitFor();
    const pagedId = await page.locator("#recollectSources input").first().getAttribute("value");
    await page.locator("#recollectSources input").first().check();
    await page.locator("#recollectSearch").fill("Roster 0938");
    assert.equal(await page.locator("#recollectSources input").count(), 1);
    const searchedId = await page.locator("#recollectSources input").getAttribute("value");
    await page.locator("#recollectSources input").check();
    assert.equal(await page.locator("#recollectSelected").innerText(), "3 selected");
    await page.getByRole("button", { name: "Show selected", exact: true }).click();
    assert.equal(await page.locator("#recollectSources input:checked").count(), 3);
    await capture(page, "recollection-940-selected");
    await page.getByRole("button", { name: "Show all chats", exact: true }).click();
    assert.equal(await page.locator("#recollectSources input").count(), 8);
    assert.equal(await page.locator("#recollectSelected").innerText(), "3 selected");
    await page.locator("#recollectSearch").fill("no such chat 940");
    assert.equal(await page.locator("#recollectSources input").count(), 0);
    assert.equal(await page.getByText("No chats match. Try another name.", { exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    assert.equal(await page.locator("#recollectSources input").count(), 8);
    assert.deepEqual(requests, [], "Search and page navigation never send source queries or mutations");
    await page.locator("#recollectFrom").fill(f.firstDay);
    await page.locator("#recollectTo").fill(f.firstDay);
    await capture(page, "recollection-940-roster");
    await page.locator("#recollectPreview").click();
    await page.locator("#recollectConfirmation").waitFor({ state: "visible" });
    const requested = requests.find(request => request.url().endsWith("/api/recollection/preview")).postDataJSON();
    assert.deepEqual(new Set(requested.sourceSessionIds), new Set([f.sourceId, pagedId, searchedId]));
    assert.match(await page.locator("#recollectSummary").innerText(), /1 request record/);
    assert.match(await page.locator("#recollectStatus").innerText(), /Some history is unavailable or incomplete/);
    assert.equal(await page.locator("#recollectAvailabilityToggle").evaluate(node => node.parentElement.open), false);
    assert.match(await page.locator("#recollectPreserved").innerText(), /Responses and feedback stay deleted/);
    await page.setViewportSize({ width: 375, height: 950 });
    await capture(page, "recollection-940-partial-375");
    await page.locator("#recollectAvailabilityToggle").click();
    await page.locator("#recollectDialog").evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight; });
    await visibleHeaderExit(page);
    await capture(page, "recollection-preview-header-exit-scrolled");
    await page.locator("#recollectClose").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "recollectActivity");
    assert.deepEqual(await loadBoardState(f.context), before);
    assert.equal(deletionHash(await readFile(f.dbPath)), sourceHash);
    assert.equal(requests.filter(request => request.url().endsWith("/confirm")).length, 0);
});
