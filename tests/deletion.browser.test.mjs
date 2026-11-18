import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture, navigateMain, navigateSettings, chooseTheme, selectActivityOption } from "./helpers.mjs";
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

async function setup(t, { frontend, savedReport = false } = {}) {
    const first = fixture("earlier"), second = fixture("later");
    first.toolCalls[0].startedAt = "2026-09-29T12:00:00Z";
    second.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    const { context } = await privateFixture(t, [first, second]);
    const exports = createExportController(context);
    if (savedReport) {
        const state = await loadBoardState(context);
        const preview = await exports.preview("preserved-deletion-report", undefined, {
            saveMode: "local", promptMode: "masked", formats: ["json"],
        }, { kind: "all", revision: state.revision });
        await exports.confirm("preserved-deletion-report", preview.previewId, true, preview.snapshot.timeContext,
            { localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false } });
    }
    const saved = (await loadBoardState(context)).exports;
    const savedFiles = await Promise.all(saved.flatMap(bundle => Object.values(bundle.files))
        .map(async file => [file, await readFile(file)]));
    const runtime = await startServer(context, exports, { port: 0, frontend, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    await page.goto(runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    return { page, context, runtime, browser, async preservedSaved() {
        assert.deepEqual((await loadBoardState(context)).exports, saved);
        for (const [file, bytes] of savedFiles) assert.deepEqual(await readFile(file), bytes);
    } };
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
async function prepareCurrentReport(page) {
    await navigateMain(page, "reports");
    await page.locator("#reportGallery").getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.locator("#reportDatefrom").fill("2026-09-29");
    await page.locator("#reportDateto").fill("2026-09-30");
    await page.getByRole("button", { name: "Use dates", exact: true }).click();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="all"]').click();
    assert.equal((await (await preparing).json()).records.length, 2);
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

test("another panel scrubs held prepared report copies at accepted activity deletion", { timeout: 30000 }, async t => {
    const { page, browser, context, runtime } = await setup(t, { frontend: "react" });
    const second = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC" });
    await second.goto(runtime.url);
    await second.locator("#workspace[aria-busy=false]").waitFor();
    await prepareCurrentReport(second);
    await selectActivityOption(second, "preparedReportView", "text");
    await second.locator(".prompt-comparison").first().waitFor();
    await second.getByText("Edit or omit this report copy", { exact: true }).click();
    await second.locator(".prompt-comparison textarea").fill("SYNTHETIC_PRIVATE_UNSAVED_COPY");
    const held = await second.evaluate(() => {
        const root = document.querySelector("#reportReviewBody");
        window.heldReportText = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) heldReportText.push(walker.currentNode);
        window.heldReportAttributes = [...root.querySelectorAll("*")].flatMap(node => [...node.attributes])
            .filter(attribute => /^(data-|href$|srcdoc$|title$|aria-label$)/.test(attribute.name));
        window.heldReportField = root.querySelector(".prompt-comparison textarea");
        window.heldReportApply = root.querySelector(".report-copy-controls button");
        const replace = root.replaceChildren;
        root.replaceChildren = function (...children) {
            if (this.childElementCount && !children.length) window.reportBeforeDetach = {
                privateText: heldReportText.filter(node => node.data.includes("SYNTHETIC_PRIVATE")).length,
                privateField: Number(Boolean(heldReportField.value)),
            };
            return replace.apply(this, children);
        };
        return { text: heldReportText.filter(node => node.data.includes("SYNTHETIC_PRIVATE")).length,
            attributes: heldReportAttributes.length };
    });
    assert.ok(held.text >= 2, "Retain both original and masked report-copy Text objects, including the hidden original.");
    const proofs = process.env.WIRE_DELETION_PROOFS;
    if (proofs) { await mkdir(proofs, { recursive: true }); await second.screenshot({ path: path.join(proofs, "prepared-before-deletion.png") }); }
    await openSettings(page);
    await previewAll(page);
    const confirming = page.waitForResponse(response => response.url().endsWith("/api/deletion/confirm"));
    await page.locator("#deleteConfirm").click();
    const receipt = await (await confirming).json();
    await page.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    await second.bringToFront();
    await second.waitForFunction(() => !document.querySelector("#reportReviewBody").childElementCount);
    assert.equal(await second.locator("[name=reportScope]:checked").inputValue(), "selected");
    await expect(second.locator("#previewSelectionSummary")).toHaveText("No interactions included");
    const retired = await second.evaluate(() => ({
        privateText: heldReportText.filter(node => node.data.includes("SYNTHETIC_PRIVATE")).length,
        privateAttributes: heldReportAttributes.filter(attribute => /SYNTHETIC_PRIVATE|email@example/.test(attribute.value)).length,
        privateField: Number(Boolean(heldReportField.value || heldReportField.defaultValue)),
    }));
    const beforeDetach = await second.evaluate(() => reportBeforeDetach);
    if (proofs) {
        await second.screenshot({ path: path.join(proofs, "prepared-after-deletion.png") });
        await writeFile(path.join(proofs, "held-copy-retirement.json"), JSON.stringify({
            held, retired, beforeDetach,
            receipt: { operationId: receipt.operationId, kind: receipt.kind, phase: receipt.phase,
                records: receipt.counts.records, savedReports: receipt.counts.savedReports },
            visibleReportCleared: true, selectedInteractions: 0,
        }, null, 2));
    }
    assert.deepEqual(retired, { privateText: 0, privateAttributes: 0, privateField: 0 });
    assert.deepEqual(beforeDetach, { privateText: 0, privateField: 0 });
    const callbacks = [];
    second.on("request", request => { if (/\/api\/(?:preview|export)$/.test(request.url())) callbacks.push(request.url()); });
    await second.evaluate(() => heldReportApply.click());
    await second.waitForTimeout(450); // Beyond the report-copy update debounce, not just the next paint.
    assert.deepEqual(callbacks, []);
    assert.equal((await loadBoardState(context)).evidence.length, 0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await second.close();
});

for (const mode of ["report", "html", "source"]) test(`activity deletion retires held ${mode} payloads and stale actions, not saved files`, { timeout: 30000 }, async t => {
    const app = await setup(t, { frontend: "react", savedReport: true }), { page, browser, runtime, context } = app;
    await prepareCurrentReport(page);
    if (mode === "report") {
        const frame = page.frameLocator(".report-contained-frame");
        await frame.locator(".wire-reading-interaction>summary").first().click();
        await frame.locator(".wire-example-editor summary").first().click();
        await frame.getByLabel("Your note", { exact: true }).first().fill("SYNTHETIC_PRIVATE_UNSAVED_NOTE");
    } else {
        await selectActivityOption(page, "preparedReportView", "product-report.html");
        if (mode === "source") await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
        else await expect(page.frameLocator("#reportFileInspection iframe").locator("h1")).toBeVisible();
    }
    const retained = await page.evaluate(() => {
        const root = document.querySelector("#reportReviewBody");
        const frame = root.querySelector(".report-contained-frame");
        const nodes = [...root.querySelectorAll("*"), ...frame.contentDocument.querySelectorAll("*")];
        window.heldPreparedTexts = nodes.flatMap(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE));
        window.heldPreparedAttrs = nodes.flatMap(node => [...node.attributes])
            .filter(attribute => /^(data-|href$|srcdoc$|title$|aria-label$)/.test(attribute.name));
        window.heldPreparedFields = nodes.filter(node => node.matches("input,textarea"));
        window.heldPreparedSave = document.querySelector("#reportSaveActions button");
        window.heldPreparedEdit = frame.contentDocument.querySelector(".wire-example-editor button");
        return { text: heldPreparedTexts.filter(node => node.data.includes("SYNTHETIC_PRIVATE")).length,
            attributes: heldPreparedAttrs.filter(node => node.value.includes("SYNTHETIC_PRIVATE")).length };
    });
    assert.ok(retained.text + retained.attributes > 0);
    const controller = mode === "report" ? page : await browser.newPage();
    if (controller !== page) { await controller.goto(runtime.url); await controller.locator("#workspace[aria-busy=false]").waitFor(); }
    await openSettings(controller); await previewAll(controller);
    await controller.locator("#deleteCancel").click();
    assert.equal(await page.evaluate(() => heldPreparedTexts.some(node => node.data.includes("SYNTHETIC_PRIVATE"))
        || heldPreparedAttrs.some(node => node.value.includes("SYNTHETIC_PRIVATE"))), true, "Cancel is not retirement.");
    assert.equal((await loadBoardState(context)).evidence.length, 2, "Cancel does not delete retained activity.");
    await app.preservedSaved();
    await openSettings(controller); await previewAll(controller);
    const committed = controller.waitForResponse(response => response.url().endsWith("/api/deletion/confirm"));
    await controller.locator("#deleteConfirm").click();
    assert.equal((await committed).status(), 200);
    await page.bringToFront();
    await page.waitForFunction(() => !document.querySelector("#reportReviewBody").childElementCount);
    assert.deepEqual(await page.evaluate(() => ({
        text: heldPreparedTexts.filter(node => node.data.includes("SYNTHETIC_PRIVATE")).length,
        attributes: heldPreparedAttrs.filter(node => node.value !== "").length,
        fields: heldPreparedFields.filter(node => node.value || node.defaultValue).length,
    })), { text: 0, attributes: 0, fields: 0 });
    const writes = [];
    page.on("request", request => { if (/\/api\/(?:export|preview)$/.test(request.url())) writes.push(request.url()); });
    await page.evaluate(() => { heldPreparedEdit?.click(); heldPreparedSave.click(); });
    await page.waitForTimeout(450);
    assert.deepEqual(writes, [], "Detached editor and Save controls cannot republish or write deleted data.");
    assert.equal((await loadBoardState(context)).evidence.length, 0);
    await app.preservedSaved();
    await controller.locator("#deleteCancel").click();
    await navigateMain(page, "reports");
    await page.locator(".saved-report-name").first().click();
    await expect(page.frameLocator("#savedReportReader iframe").locator("body")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await app.preservedSaved();
});

test("activity deletion retires an in-flight prepared response before it can republish copies", { timeout: 30000 }, async t => {
    const { page, browser, runtime, context } = await setup(t, { frontend: "react" });
    const controller = await browser.newPage();
    await controller.goto(runtime.url); await controller.locator("#workspace[aria-busy=false]").waitFor();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/preview", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    const preparing = prepareCurrentReport(page);
    await entered.promise;
    await openSettings(controller); await previewAll(controller); await controller.locator("#deleteConfirm").click();
    await controller.waitForFunction(() => document.querySelector("#deleteTitle").textContent === "Collected activity deleted");
    await page.bringToFront();
    await expect(page.locator("#previewSelectionSummary")).toHaveText("No interactions included");
    release.resolve(); await preparing;
    await expect(page.locator("#reportReviewBody")).toBeEmpty();
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeHidden();
    assert.equal((await loadBoardState(context)).exports.length, 0);
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
