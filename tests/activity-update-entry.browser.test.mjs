import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { selectActivityOption, navigateMain, navigateSettings, openSourceEditor, chooseTheme, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, scanReport } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

async function capture(page, name) {
    if (!process.env.WIRE_ACTIVITY_UPDATE_PROOF_DIR) return;
    await mkdir(process.env.WIRE_ACTIVITY_UPDATE_PROOF_DIR, { recursive: true });
    await page.evaluate(async () => { await document.fonts.ready; getSelection().removeAllRanges(); });
    await page.screenshot({ path: path.join(process.env.WIRE_ACTIVITY_UPDATE_PROOF_DIR, `${name}.png`) });
}

async function readableDisabled(page, selector) {
    const paint = await page.locator(selector).evaluate(node => {
        const css = getComputedStyle(node), face = getComputedStyle(node, "::before");
        let background = face.backgroundColor, opacity = 1;
        for (let current = node; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            opacity *= Number(style.opacity);
            if (background === "rgba(0, 0, 0, 0)") background = style.backgroundColor;
        }
        return { disabled: node.disabled, color: css.color, background, opacity, height: node.getBoundingClientRect().height };
    });
    assert.equal(paint.disabled, true);
    assert.equal(paint.opacity, 1, "Disabled text must not be dimmed by whole-control opacity");
    assert.ok(contrast(paint.color, paint.background) >= 4.5, JSON.stringify(paint));
    assert.ok(paint.height >= 44);
}

test("freshness opens the existing guarded local-check and stored-read actions beside the scope", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], effects = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/\/api\/collection\/(?:now|configure|enabled)$/.test(request.url())) effects.push(new URL(request.url()).pathname); });
    f.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.goto(f.runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    const entry = page.locator("#activityUpdateToggle");
    assert.equal(await entry.count(), 1);
    assert.equal(await entry.evaluate(node => node.closest("#periodMeta") !== null), true);
    assert.equal(await page.locator("#freshActivity").isVisible(), false);
    assert.match(await entry.innerText(), /Collection paused/);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false, "The freshness entry already names an ordinary pause");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(page, `entry-${theme}-closed`);
    }
    const original = await page.locator("#checkActivity").elementHandle();
    const configFile = path.join(f.context.dataDir, "collector", "config.json"), config = await readFile(configFile);
    const target = await entry.boundingBox();
    assert.ok(target.height >= 44);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await capture(page, "entry-dark-pressed");
    await page.mouse.up();
    await expect(page.locator("#checkActivity")).toHaveText("Check local history");
    await expect(page.locator("#freshStoredRead")).toBeVisible();
    await expect(page.locator("#freshSourceSettings")).toHaveAttribute("href", "#settings?section=connection");
    assert.equal(await page.locator(".page-heading #checkActivity").count(), 0);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(page, `entry-${theme}-expanded`);
    }
    await page.locator("#checkActivity").hover();
    await capture(page, "check-dark-hover");
    await page.locator("#checkActivity").focus();
    await page.keyboard.press("Tab");
    await capture(page, "stored-read-dark-keyboard-focus");
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.locator("#freshStoredRead").click(); await read;
    await page.locator("#workspace[aria-busy=false]").waitFor();
    assert.deepEqual(effects, []);
    assert.equal(await page.locator("#recollectDialog").isVisible(), false);
    const at = `${f.firstDay}T14:00:00.000Z`, id = randomUUID();
    await appendFile(f.files[0], [
        { id: randomUUID(), type: "tool.execution_start", timestamp: at, data: { toolCallId: id, toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", arguments: { entityUrls: ["/me/messages"] } } },
        { id: randomUUID(), type: "tool.execution_complete", timestamp: at, data: { toolCallId: id, success: true } },
    ].map(value => JSON.stringify(value) + "\n").join(""));
    await page.locator("#checkActivity").click();
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete"
        && document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    assert.equal(await page.locator("#checkActivity").evaluate((node, original) => node === original, original), true);
    assert.deepEqual(effects, ["/api/collection/now"]);
    assert.deepEqual(await readFile(configFile), config);
    assert.equal((await f.collector.status()).config.enabled, false);
    assert.equal((await loadBoardState(f.context)).evidence.flatMap(row => row.toolCalls).length, 4);
    await expect(page.locator("#freshStatus")).toHaveText("1 new activity record.");
    await capture(page, "check-complete-return");
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await page.mouse.move(450, 400); await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => scrollY === 0);
    const reader = await page.locator("#contextSidebar").boundingBox(), updates = await entry.boundingBox();
    assert.ok(updates.x + updates.width <= reader.x, "The entry remains in the activity surface beside the docked reader");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.mouse.move(450, 400); await page.mouse.wheel(0, -10000);
        await page.waitForFunction(() => scrollY === 0);
        await capture(page, `entry-${theme}-docked-reader`);
    }
    await page.locator("#closeContextSidebar").click();
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await entry.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    for (const id of ["activityUpdateToggle", "checkActivity", "freshStoredRead", "freshRecollect"]) {
        const box = await page.locator("#" + id).boundingBox();
        assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 376, `${id}: ${JSON.stringify(box)}`);
    }
    await capture(page, "entry-dark-narrow-enlarged-scrolled");
});

test("Analyze recollection uses the authoritative preview and preserves the displayed date scope", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t);
    const deletion = createDeletionController(f.context);
    const remove = await deletion.preview("fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("fixture", { operationId: remove.operationId, confirmed: true });
    const sourceBefore = await Promise.all(f.files.map(file => readFile(file, "utf8")));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], sourceChecks = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().endsWith("/api/collection/now")) sourceChecks.push(request.url()); });
    f.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    await selectActivityOption(page, "dateFilter", "day"); await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#activityUpdateToggle").click();
    assert.equal(await page.locator("#freshRecollect").count(), 1);
    const trigger = await page.locator("#freshRecollect").elementHandle();
    await page.locator("#freshRecollect").click();
    await page.waitForFunction(() => document.querySelector("#recollectPreview").dataset.pending === "false"
        && document.querySelectorAll("#recollectSources input").length > 0);
    assert.equal(await page.locator("#recollectPreview").isDisabled(), true, "A source list alone is not a selected preview scope");
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        await readableDisabled(page, "#recollectPreview");
        await capture(page, `selection-${theme}-disabled`);
    }
    await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
    await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
    const response = page.waitForResponse(response => response.url().endsWith("/api/recollection/preview"));
    await page.locator("#recollectPreview").click();
    const preview = await (await response).json();
    await expect(page.locator("#recollectTitle")).toHaveText("Read this record again?");
    assert.equal(preview.counts.records, 1);
    assert.match(await page.locator("#recollectSummary").innerText(), /1 previously deleted/);
    assert.equal(await page.locator("#recollectDialog").getAttribute("data-decision-kind"), null);
    assert.equal(await page.locator("#recollectChange").evaluate(node => node.closest(".decision-scope") !== null), true);
    await capture(page, "confirmation-dark");
    let release, confirmations = 0;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/recollection/confirm", async route => {
        confirmations++; const result = await route.fetch(); await held; await route.fulfill({ response: result });
    });

    try {
        await page.locator("#recollectConfirm").click();
        await expect(page.locator("#recollectDialog")).toHaveAttribute("data-decision-phase", "pending");
        assert.equal(await page.locator("#recollectClose").isDisabled(), true);
        await page.keyboard.press("Escape"); assert.equal(await page.locator("#recollectDialog").isVisible(), true);
        for (const theme of ["light", "dark"]) {
            await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
            await readableDisabled(page, "#recollectConfirm");
            await capture(page, `pending-${theme}-disabled`);
        }
    } finally { release(); }
    await expect(page.locator("#recollectDialog")).toHaveAttribute("data-decision-phase", "complete");
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await capture(page, "recollection-complete");
    await page.locator("#recollectClose").click();
    await page.waitForFunction(() => document.activeElement.id === "freshRecollect");
    assert.equal(await page.locator("#freshRecollect").evaluate((node, trigger) => node === trigger, trigger), true);
    assert.equal(await page.locator("#dateFilter").inputValue(), "day");
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    assert.match(await page.locator("#recollectionUpdateStatus").innerText(), /Recollected 1 record/);
    assert.match(await page.locator("#recollectionUpdateStatus").innerText(), /may be outside/);
    assert.equal(confirmations, 1); assert.deepEqual(sourceChecks, []);
    assert.deepEqual((await loadBoardState(f.context)).evidence.flatMap(row => row.toolCalls.map(call => call.toolCallId)), ["selected-A"]);
    assert.deepEqual(await Promise.all(f.files.map(file => readFile(file, "utf8"))), sourceBefore);
    await capture(page, "recollection-return-current-filters");
});

test("reloaded B recovery reads the same receipt without scanning or inventing the earlier scope", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t), deletion = createDeletionController(f.context);
    const remove = await deletion.preview("fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("fixture", { operationId: remove.operationId, confirmed: true });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().includes("/api/recollection/")) requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    f.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#activityUpdateToggle").click(); await page.locator("#freshRecollect").click();
    await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
    await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
    await page.locator("#recollectPreview").click(); await expect(page.locator("#recollectDialog")).toHaveAttribute("data-decision-phase", "confirm");
    await page.route("**/api/recollection/confirm", async route => { await route.fetch(); await route.abort("failed"); });
    await page.locator("#recollectConfirm").click(); await expect(page.locator("#recollectDialog")).toHaveAttribute("data-decision-phase", "unknown");
    await capture(page, "unknown-retained-scope");
    const operationId = await page.locator("#recollectDialog").getAttribute("data-operation-id");
    const retainedReceipt = await page.evaluate(() => JSON.parse(sessionStorage.getItem("workiq-evidence.recollection-operation")));
    await page.reload(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await expect(page.locator("#freshRecollect")).toHaveText("Check recollection result");
    await page.locator("#freshRecollect").click();
    await expect(page.locator("#recollectScopeUnavailable")).toBeVisible();
    assert.equal(await page.locator("#recollectConfirmation").isVisible(), false);
    assert.equal(await page.locator("#recollectConfirm").isVisible(), false);
    assert.deepEqual(await page.locator("#recollectDialog>.delete-actions button:visible").allTextContents(), ["Close", "Check recollection result"]);
    await capture(page, "unknown-after-reload");
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/recollection/status", async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
    let frozen, frozenNode, frozenHtml;
    try {
        await page.locator("#recollectCheck").click(); await expect(page.locator("#recollectDialog")).toHaveAttribute("data-decision-phase", "checking");
        assert.equal(await page.locator("#recollectClose").isEnabled(), true);
        await capture(page, "receipt-read-pending");
        await page.locator("#recollectClose").click();
        await page.waitForFunction(() => document.activeElement.id === "freshRecollect");
        await navigateMain(page, "reports"); await chooseReportScope(page, "all"); await scanReport(page);
        frozen = page.locator("#reportReviewBody iframe"); frozenNode = await frozen.elementHandle();
        frozenHtml = await frozen.getAttribute("srcdoc");
    } finally { release(); }
    await page.waitForFunction(() => !sessionStorage.getItem("workiq-evidence.recollection-operation"));
    await page.locator("#workspace[aria-busy=false]").waitFor();
    assert.equal(await page.locator("#recollectDialog").isVisible(), false);
    await expect(page.locator("#recollectionUpdateStatus")).toContainText("Recollected 1 record");
    assert.equal(await frozen.getAttribute("srcdoc"), frozenHtml, "A late receipt cannot replace a frozen report");
    assert.equal(await frozen.evaluate((node, original) => node === original, frozenNode), true);
    assert.equal(requests.filter(value => value.path.endsWith("/confirm")).length, 1);
    assert.equal(requests.filter(value => value.path.endsWith("/sources")).length, 1);
    assert.equal(requests.filter(value => value.path.endsWith("/preview")).length, 1);
    const reads = requests.filter(value => value.path.endsWith("/status"));
    assert.equal(reads.length, 1); assert.equal(reads[0].body.operationId, operationId);
    assert.deepEqual(reads[0].body, retainedReceipt, "A valid retained identity and token are used unchanged");
    assert.deepEqual((await loadBoardState(f.context)).evidence.flatMap(row => row.toolCalls.map(call => call.toolCallId)), ["selected-A"]);
    await capture(page, "receipt-recovered-frozen-report");
});

test("B actions preserve dirty Settings and a frozen report without dispatch", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t), browser = await chromium.launch();
    f.closeClient(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, reducedMotion: "reduce" }), effects = [];
    page.on("request", request => {
        if (/\/api\/(?:collection\/(?:now|configure|enabled)|recollection\/(?:sources|preview|confirm))$/.test(request.url())) effects.push(request.url());
    });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(page, "settings"); await navigateSettings(page, "connection"); await openSourceEditor(page);
    const draft = await page.locator("#sourceSessions").inputValue() + "-unsaved";
    await page.locator("#sourceSessions").fill(draft);
    await navigateMain(page, "analyze"); await page.locator("#activityUpdateToggle").click();
    for (const id of ["checkActivity", "freshStoredRead", "freshRecollect"]) await expect(page.locator("#" + id)).toBeDisabled();
    await capture(page, "entry-dirty-settings");
    await navigateMain(page, "settings"); await navigateSettings(page, "connection");
    assert.equal(await page.locator("#sourceSessions").inputValue(), draft);
    await page.locator("#cancelSource").click();
    await navigateMain(page, "reports"); await chooseReportScope(page, "all"); await scanReport(page);
    const frozen = await page.locator("#reportReviewBody iframe").getAttribute("srcdoc");
    await navigateMain(page, "analyze");
    for (const id of ["checkActivity", "freshStoredRead", "freshRecollect"]) await expect(page.locator("#" + id)).toBeDisabled();
    assert.equal(await page.locator("#reportReviewBody iframe").getAttribute("srcdoc"), frozen);
    assert.deepEqual(effects, []);
});

test("failed or incomplete previews cannot commit and a failed result view recovers only by stored read", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t), deletion = createDeletionController(f.context);
    const remove = await deletion.preview("fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("fixture", { operationId: remove.operationId, confirmed: true });
    const browser = await chromium.launch(); f.closeClient(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    let confirmations = 0;
    page.on("request", request => { if (request.url().endsWith("/api/recollection/confirm")) confirmations++; });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    await chooseTheme(page, "dark");
    await page.locator("#activityUpdateToggle").click(); await page.locator("#freshRecollect").click();
    await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
    await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
    await page.route("**/api/recollection/preview", route => route.fulfill({ status: 503, json: { error: "Synthetic source read failure" } }));
    await page.locator("#recollectPreview").click();
    await expect(page.locator("#recollectStatus")).toContainText("Preview failed. Nothing changed.");
    assert.equal(await page.locator("#recollectConfirm").isVisible(), false);
    await capture(page, "failed-preview-dark");
    await page.unroute("**/api/recollection/preview");
    await page.route("**/api/recollection/preview", async route => {
        const response = await route.fetch(), body = await response.json();
        delete body.counts.records;
        await route.fulfill({ response, json: body });
    });
    await page.locator("#recollectPreview").click();
    await expect(page.locator("#recollectConfirm")).toBeVisible();
    await expect(page.locator("#recollectConfirm")).toBeDisabled();
    await expect(page.locator("#recollectSummary")).toContainText("count is unavailable");
    assert.doesNotMatch(await page.locator("#recollectSummary").innerText(), /0 records/);
    await page.locator("#recollectChange").click();
    await page.unroute("**/api/recollection/preview");
    await page.route("**/api/recollection/preview", async route => {
        const response = await route.fetch(), body = await response.json();
        delete body.scope;
        await route.fulfill({ response, json: body });
    });
    await page.locator("#recollectPreview").click();
    await expect(page.locator("#recollectStatus")).toContainText("complete reviewed scope");
    assert.equal(await page.locator("#recollectConfirm").isVisible(), false);
    assert.equal(confirmations, 0);
    await page.unroute("**/api/recollection/preview");
    await page.locator("#recollectPreview").click();
    await expect(page.locator("#recollectConfirm")).toBeEnabled();
    let failView = true;
    await page.route("**/api/snapshot", route => failView
        ? route.fulfill({ status: 503, json: { error: "Synthetic stored-view failure" } }) : route.continue());
    await page.locator("#recollectConfirm").click();
    await expect(page.locator("#recollectStatus")).toContainText("Recollected 1 record");
    await expect(page.locator("#recollectStatus")).toContainText("view could not refresh");
    await capture(page, "completed-view-read-failed");
    await page.locator("#recollectClose").click();
    failView = false;
    const recovery = await revealStoredRefresh(page);
    await recovery.click(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await expect(page.locator("#recollectionUpdateStatus")).toContainText("Recollected 1 record");
    await expect(page.locator("#recollectionUpdateStatus")).toContainText("Current filters are kept");
    assert.equal(await page.locator("#freshResult").isVisible(), false, "The confirmed recollection owns its successful return message");
    assert.equal(confirmations, 1);
    assert.deepEqual((await loadBoardState(f.context)).evidence.flatMap(row => row.toolCalls.map(call => call.toolCallId)), ["selected-A"]);
    await capture(page, "completed-stored-read-recovered");
});

test("a reloaded not-started receipt settles without automatically reading source metadata", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t), deletion = createDeletionController(f.context);
    const remove = await deletion.preview("fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("fixture", { operationId: remove.operationId, confirmed: true });
    const browser = await chromium.launch(); f.closeClient(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" }), paths = [];
    page.setDefaultTimeout(7000);
    page.on("request", request => { if (request.url().includes("/api/recollection/")) paths.push(new URL(request.url()).pathname); });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#activityUpdateToggle").click(); await page.locator("#freshRecollect").click();
    await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
    await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
    await page.locator("#recollectPreview").click(); await expect(page.locator("#recollectConfirm")).toBeEnabled();
    await page.route("**/api/recollection/confirm", route => route.abort("failed"));
    await page.locator("#recollectConfirm").click(); await expect(page.locator("#recollectCheck")).toBeVisible();
    await page.reload(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#freshRecollect").click();
    const before = paths.length;
    await page.locator("#recollectCheck").click();
    await expect(page.locator("#recollectStatus")).toContainText("No committed recollection");
    await expect(page.locator("#recollectCheck")).toBeHidden();
    assert.deepEqual(paths.slice(before), ["/api/recollection/status"]);
    await expect(page.locator("#recollectTitle")).toHaveText("No recollection was committed");
    assert.equal(await page.locator("#recollectForm").isVisible(), false);
    await capture(page, "receipt-not-started-no-source-read");
    await page.locator("#recollectClose").click();
    await expect(page.locator("#freshRecollect")).toBeFocused();
    await expect(page.locator("#recollectionUpdateStatus")).toContainText("No committed recollection");
    assert.deepEqual((await loadBoardState(f.context)).evidence, []);
    await page.locator("#freshRecollect").click();
    await expect(page.locator("#recollectSources input")).toHaveCount(2);
    assert.equal(paths.filter(value => value.endsWith("/sources")).length, 2, "Only a separate user intent reads the source list again");
    assert.equal(paths.filter(value => value.endsWith("/confirm")).length, 1);
});

test("one contextual update entry survives Compare and stored reads without changing paired or ordinary scopes", { timeout: 30000 }, async t => {
    const f = await recollectionFixture(t), browser = await chromium.launch();
    f.closeClient(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const effects = [];
    page.on("request", request => {
        if (/\/api\/(?:collection\/(?:now|configure|enabled)|recollection\/)/.test(request.url())) effects.push(new URL(request.url()).pathname);
    });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(f.firstDay); await page.locator("#toFilter").fill(f.firstDay);
    await page.locator("#applyDates").click(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await selectActivityOption(page, "outcomeFilter", ["success"]); await page.locator("#workspace[aria-busy=false]").waitFor();
    const entry = page.locator("#activityUpdateToggle"), original = await entry.elementHandle();
    await expect(page.locator("#periodResult")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("2");
    await page.locator("#comparePeriods").click();
    assert.equal(await entry.isVisible(), true, "Compare must not hide the only activity-update entry");
    const periods = [
        ["Period A from", f.firstDay], ["Period A to", f.firstDay],
        ["Period B from", f.secondDay], ["Period B to", f.secondDay],
    ];
    for (const [label, value] of periods) await page.getByLabel(label, { exact: true }).fill(value);
    const response = page.waitForResponse(response => response.url().endsWith("/api/period-comparison") && response.ok());
    await page.locator("#applyPeriodComparison").click(); await response;
    await expect(page.locator("#periodComparisonResultsTitle")).toBeVisible();
    for (const id of ["periodResult", "periodHint", "periodActions", "periodCoverage"]) await expect(page.locator("#" + id)).toBeHidden();
    assert.equal(await entry.evaluate((node, original) => node === original, original), true);
    assert.equal(await page.locator("#activityUpdateToggle,#checkActivity").count(), 2, "No duplicate update entry or check control");
    assert.equal(await entry.evaluate(node => Boolean(node.closest("#periodFeedback")
        .compareDocumentPosition(document.getElementById("periodComparison")) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
    "Updates precede the comparison results, not its long record roster");
    await page.mouse.move(400, 400); await page.mouse.wheel(0, -10000); await page.waitForFunction(() => scrollY === 0);
    await capture(page, "comparison-update-closed");
    await entry.click(); await expect(page.locator("#freshStoredRead")).toBeVisible();
    assert.deepEqual(effects, [], "Opening contextual updates never checks source history");
    const results = await page.locator("#periodComparisonResults").innerText();
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.locator("#freshStoredRead").click(); await read; await page.locator("#workspace[aria-busy=false]").waitFor();
    await expect(page.locator("#freshStoredRead")).toBeFocused();
    for (const [label, value] of periods) await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
    assert.equal(await page.locator("#periodComparisonResults").innerText(), results);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.deepEqual(effects, []);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.mouse.move(400, 400); await page.mouse.wheel(0, -10000); await page.waitForFunction(() => scrollY === 0);
        await capture(page, `comparison-update-${theme}`);
    }
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await entry.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => ({
        updatesBottom: document.getElementById("periodFeedback").getBoundingClientRect().bottom,
        resultsTop: document.getElementById("periodComparison").getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    assert.ok(geometry.updatesBottom <= geometry.resultsTop && geometry.overflow <= 1, JSON.stringify(geometry));
    await capture(page, "comparison-update-dark-narrow-scrolled");
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.setViewportSize({ width: 1466, height: 1000 });
    await page.getByRole("button", { name: "Stop comparing", exact: true }).click();
    await expect(page.locator("#comparePeriods")).toBeFocused();
    await expect(page.locator("#periodComparison")).toBeHidden();
    await expect(page.locator("#periodResult")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#fromFilter")).toHaveValue(f.firstDay); await expect(page.locator("#toFilter")).toHaveValue(f.firstDay);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.equal(await entry.evaluate((node, original) => node === original, original), true);
    assert.deepEqual(effects, []);
});

for (const [name, raw, unreadable] of [
    ["malformed JSON", "{unfinished", false],
    ["empty retained value", "", false],
    ["parsed null", "null", false],
    ["missing identity", JSON.stringify({ receiptToken: "a".repeat(64) }), false],
    ["invalid identity", JSON.stringify({ operationId: "-".repeat(36), receiptToken: "a".repeat(64) }), false],
    ["invalid token", JSON.stringify({ operationId: randomUUID(), receiptToken: "invalid" }), false],
    ["unreadable storage", JSON.stringify({ operationId: randomUUID(), receiptToken: "a".repeat(64) }), true],
]) {
    test(`retained recollection recovery fails closed for ${name}, without blocking stored reads`, { timeout: 20000 }, async t => {
        const f = await recollectionFixture(t), browser = await chromium.launch();
        f.closeClient(() => browser.close());
        const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" }), requests = [];
        page.setDefaultTimeout(5000);
        await page.addInitScript(({ raw, unreadable }) => {
            const key = "workiq-evidence.recollection-operation";
            const read = Storage.prototype.getItem, write = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
            write.call(sessionStorage, key, raw);
            window.receiptStorageProof = { writes: 0, removals: 0, raw: () => read.call(sessionStorage, key) };
            Storage.prototype.getItem = function (name) {
                if (this === sessionStorage && name === key && unreadable) throw new DOMException("Synthetic read denied", "SecurityError");
                return read.call(this, name);
            };
            Storage.prototype.setItem = function (name, value) {
                if (this === sessionStorage && name === key) window.receiptStorageProof.writes++;
                return write.call(this, name, value);
            };
            Storage.prototype.removeItem = function (name) {
                if (this === sessionStorage && name === key) window.receiptStorageProof.removals++;
                return remove.call(this, name);
            };
        }, { raw, unreadable });
        page.on("request", request => { if (request.url().includes("/api/recollection/")) requests.push(new URL(request.url()).pathname); });
        await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
        if (name === "malformed JSON") await chooseTheme(page, "dark");
        if (await page.locator("#activityUpdateToggle").getAttribute("aria-expanded") === "false") await page.locator("#activityUpdateToggle").click();
        await page.locator("#freshRecollect").click();
        assert.equal(await page.locator("#recollectForm").isVisible(), false, "An unreadable retained receipt cannot open fresh source selection");
        await expect(page.locator("#recollectTitle")).toHaveText("Recollection recovery unavailable");
        await expect(page.locator("#recollectStatus")).toContainText("could not be read or verified");
        assert.deepEqual(await page.locator("#recollectDialog>.delete-actions button:visible").allTextContents(), ["Close"]);
        assert.equal(await page.locator("#recollectConfirmation").isVisible(), false);
        assert.doesNotMatch(await page.locator("#recollectDialog").innerText(), /0 records|No records available/);
        await page.locator("#recollectForm").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        await page.locator("#recollectConfirm").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        await page.locator("#recollectCheck").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        if (name === "malformed JSON") await capture(page, "blocked-recollection-receipt-dark");
        await page.locator("#recollectClose").click();
        await expect(page.locator("#recollectionUpdateStatus")).toContainText("could not be read or verified");
        const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await page.locator("#freshStoredRead").click(); await read; await page.locator("#workspace[aria-busy=false]").waitFor();
        if (name === "malformed JSON") await chooseTheme(page, "light");
        await page.locator("#freshRecollect").click();
        await expect(page.locator("#recollectTitle")).toHaveText("Recollection recovery unavailable");
        if (name === "malformed JSON") await capture(page, "blocked-recollection-receipt-light");
        await page.locator("#recollectClose").click();
        assert.deepEqual(requests, [], "No source list, preview, confirmation or invented receipt lookup");
        assert.deepEqual(await page.evaluate(() => ({
            writes: window.receiptStorageProof.writes, removals: window.receiptStorageProof.removals, raw: window.receiptStorageProof.raw(),
        })), { writes: 0, removals: 0, raw });
        await navigateMain(page, "reports");
        await expect(page.locator("#reportsView")).toBeVisible();
    });
}
