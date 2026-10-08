import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture, navigateMain, navigateSettings, chooseTheme } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { reportContents, chooseReportScope } from "./report-journey-helpers.mjs";

test("anonymous local records are qualified in deletion preview, not presented as verified distinct tool calls", { timeout: 15000 }, async t => {
    const record = fixture("anonymous-preview");
    record.toolCalls = [{ tool: "unknown", startedAt: "2026-10-01T00:00:00.000Z", requestArgs: { method: "GET", path: "/synthetic" } }];
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await openSettings(page);
    await previewAll(page);
    assert.match(await page.locator("#deleteBreakdown").innerText(), /1 local record without a source identifier/);
    assert.match(await page.locator("#deleteBreakdown").innerText(), /not verified distinct invocations/);
    assert.doesNotMatch(await page.locator("#deleteBreakdown").innerText(), /1 tool call/);
    await page.keyboard.press("Escape");
    assert.equal((await loadBoardState(context)).deletion, undefined);
});

async function setup(t) {
    const first = fixture("earlier"), second = fixture("later");
    first.toolCalls[0].startedAt = "2026-09-29T12:00:00Z";
    second.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    const { context } = await privateFixture(t, [first, second]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    await page.goto(runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    return { page, context, runtime, browser };
}
async function openSettings(page) {
    await navigateMain(page, "settings");
    await navigateSettings(page, "data");
    await page.locator("#deleteActivity").click();
}
async function previewAll(page) {
    await page.locator("#deleteAll").check();
    await page.locator("#deletePreview").click();
    await page.locator("#deleteConfirmation").waitFor({ state: "visible" });
}

test("native all/range confirmation, safe focus, Escape/cancel, invalid/empty, and exact committed counts", { timeout: 45000 }, async t => {
    const { page, context } = await setup(t);
    const before = await loadBoardState(context);
    await openSettings(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteCancel");
    assert.equal(await page.locator("#deleteRange").isChecked(), true);
    assert.equal(await page.locator("#deleteFrom").inputValue(), "");
    await page.locator("#deletePreview").click();
    await page.waitForFunction(() => document.querySelector("#deleteStatus").textContent.includes("Preview failed"));
    assert.equal(await page.locator("#deleteConfirm").isEnabled(), false);
    await previewAll(page);
    assert.equal(await page.locator("#deleteConfirm").innerText(), "Delete 2 records");
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteCancel");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteActivity");
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    await navigateMain(page, "activity");
    await page.locator("#activityDeleteShortcut").click();
    await previewAll(page);
    await page.locator("#deleteChangeScope").click();
    await page.locator("#deleteRange").check();
    assert.equal(await page.locator("#deleteConfirm").isEnabled(), false);
    await page.locator("#deleteFrom").fill("2026-09-30");
    await page.locator("#deleteTo").fill("2026-09-30");
    await page.locator("#deletePreview").click();
    await page.locator("#deleteConfirmation").waitFor({ state: "visible" });
    assert.equal(await page.locator("#deleteConfirm").innerText(), "Delete 1 record");
    await page.locator("#deleteConfirm").click();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    assert.deepEqual((await loadBoardState(context)).evidence.map(row => row.scenarioId), ["earlier"]);
    await page.locator("#deleteCancel").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "activityDeleteShortcut");
    await page.locator("#activityDeleteShortcut").click();
    await previewAll(page);
    await page.locator("#deleteConfirm").click();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    assert.deepEqual((await loadBoardState(context)).evidence, []);
    await page.locator("#deleteCancel").click();
    await page.locator("#activityDeleteShortcut").click();
    await page.locator("#deleteAll").check();
    await page.locator("#deletePreview").click();
    await page.waitForFunction(() => document.querySelector("#deleteStatus").textContent.includes("Nothing to delete"));
    assert.equal(await page.locator("#deleteConfirm").isEnabled(), false);
});

test("another panel drops its stale report copies and membership after committed deletion", { timeout: 25000 }, async t => {
    const { page, browser, context, runtime } = await setup(t);
    const second = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC" });
    await second.goto(runtime.url);
    await second.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(second, "reports");
    await chooseReportScope(second, "all");
    await reportContents(second);
    await second.locator("#exportBtn").click();
    await second.locator("#reportReviewBody iframe").waitFor();
    await openSettings(page);
    await previewAll(page);
    await page.locator("#deleteConfirm").click();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    await second.bringToFront();
    await second.waitForFunction(() => !document.querySelector("#reportReviewBody").childElementCount);
    assert.equal(await second.locator("[name=reportScope]:checked").inputValue(), "selected");
    assert.match(await second.locator("#previewSelectionSummary").textContent(), /No requests selected/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await second.close();
});

test("lost mutation response and stale preview use read-only recovery, never automatic confirmation replay", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t);
    await openSettings(page);
    await previewAll(page);
    await replaceEvidence(context, (records, importCoverage) => ({ records: [...records, fixture("concurrent")], importCoverage }));
    await page.locator("#deleteConfirm").click();
    await page.locator("#deleteCheck").waitFor({ state: "visible" });
    assert.equal((await loadBoardState(context)).evidence.length, 3);
    await page.locator("#deleteCheck").click();
    await page.waitForFunction(() => document.querySelector("#deleteStatus").textContent.includes("No committed deletion"));
    await previewAll(page);
    let commits = 0;
    await page.route("**/api/deletion/confirm", async route => {
        commits++;
        await route.fetch();
        await route.abort("failed");
    });

    await page.locator("#deleteConfirm").click();
    await page.locator("#deleteCheck").waitFor({ state: "visible" });
    await page.locator("#deleteCheck").click();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    assert.equal(commits, 1);
    assert.deepEqual((await loadBoardState(context)).evidence, []);
});

test("pending confirmation is visible, cannot be duplicated or dismissed, and blocks background controls", { timeout: 20000 }, async t => {
    const { page, context } = await setup(t);
    await openSettings(page);
    await previewAll(page);
    let release, commits = 0;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/deletion/confirm", async route => { commits++; await gate; await route.continue(); });
    await page.locator("#deleteConfirm").click();
    await page.waitForFunction(() => document.querySelector("#deleteConfirm").getAttribute("aria-busy") === "true");
    assert.equal(await page.locator("#deleteCancel").isEnabled(), false);
    assert.equal(await page.locator("#deleteChangeScope").isEnabled(), false);
    assert.match(await page.locator("#deleteStatus").textContent(), /Deleting the confirmed records/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#deleteDialog").evaluate(node => node.matches(":modal")), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteStatus");
    assert.equal((await loadBoardState(context)).evidence.length, 2);
    assert.equal(commits, 1);
    release();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    assert.equal(commits, 1);
});

test("confirmation is readable, keyboard-contained and non-color-only at responsive light/navy sizes", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const proof = process.env.DELETION_PROOF_DIR;
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await openSettings(page);
        await previewAll(page);
        for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            assert.equal(await page.locator("#deleteDialog").evaluate(node => node.scrollWidth <= node.clientWidth), true, `${theme}/${width}/${scale}`);
            assert.ok((await page.locator("#deleteCancel").boundingBox()).height >= 44);
            assert.match(await page.locator("#deleteDialog .delete-irreversible").innerText(), /cannot be undone/);
            await page.locator("#deleteConfirm").focus();
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.querySelector("#deleteDialog").contains(document.activeElement)), true);
            const colors = await page.locator("#deleteConfirm").evaluate(node => {
                const css = getComputedStyle(node);
                return { foreground: css.color, background: css.backgroundColor };
            });
            const luminance = color => color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
            const fg = luminance(colors.foreground), bg = luminance(colors.background);
            assert.ok((Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5);
            if (proof) {
                await page.locator("#deleteDialog").evaluate(node => { node.scrollTop = 0; });
                await page.screenshot({ path: path.join(proof, `deletion-${theme}-${width}-${scale * 100}.png`) });
                await page.locator("#deleteCancel").scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(proof, `deletion-actions-${theme}-${width}-${scale * 100}.png`) });
            }
        }
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1200, height: 1000 });
    }
});
