import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { chooseTheme, navigateMain } from "./helpers.mjs";
import { openReportCreation, reportContents, scanReport, inspectReportCopies } from "./report-journey-helpers.mjs";

test("normal Setup Review Save includes edited bounded context without changing hidden selected scope", { timeout: 90000 }, async t => {
    const cleanup = [];
    const { context: store, records } = await reportContextFixture({ after: action => cleanup.push(action) });
    let server, browser, forbidden = 0;
    t.after(async () => {
        try { await browser?.close(); await server?.close(); }
        finally { for (const action of cleanup) await action(); }
    });

    server = await startServer(store, createExportController(store), { port: 0, collector: { timers: false },
        evaluation: { readSource: async () => { forbidden++; throw Error("No source reads."); },
            evaluatorFactory: async () => { forbidden++; throw Error("No model calls."); } } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [], denied = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview"];
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        requests.push(url.pathname);
        return route.continue();
    });
    page.setDefaultTimeout(8000);
    await page.goto(server.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const row = page.locator("#activityList .request-row").filter({ hasText: "Three synthetic documents" });
    await row.locator("input[type=checkbox]").check();
    await page.locator("#activitySearch").fill("UNRELATED_CONTEXT");
    await navigateMain(page, "reports");
    await openReportCreation(page);
    await expect(page.locator("#reportPopulationNote")).toContainText("1 complete request group");
    await expect(page.locator("#reportPopulationNote")).toContainText("outside the current browsing filters");
    const analyticalScope = await page.locator("#reportPopulationNote").textContent();
    const contextOption = page.locator("#reportRecordedContext");
    assert.equal(await contextOption.isChecked(), false, "Context requires a deliberate Setup choice");
    await contextOption.focus();
    await page.keyboard.press("Space");
    assert.equal(await contextOption.isChecked(), true);
    assert.equal(await page.locator("#promptOptions #reportRecordedContext").count(), 0,
        "Context help must not stretch every equal-height prompt-mode row");
    const enlargedSetup = await page.addStyleTag({ content: "html { font-size: 200%; }" });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 950 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator(".prompt-choice").filter({ has: contextOption }).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        if (process.env.WIRE_REPORT_CONTEXT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_CONTEXT_PROOFS, { recursive: true });
            await page.locator(".report-text-options").screenshot({ path: path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, `context-setup-${theme}-375-200.png`) });
        }
    }
    await enlargedSetup.evaluate(node => node.remove());
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.locator("#formatOptions input[value=json]").check();
    await page.locator("#formatOptions input[value=markdown]").check();
    const before = await loadBoardState(store);
    const preview = await scanReport(page);
    assert.equal(preview.records.length, 1);
    assert.match(JSON.stringify(preview.snapshot.recordedContext), /Here are three synthetic/);
    assert.doesNotMatch(JSON.stringify(preview.snapshot.recordedContext), /reply@example|first@example|UNRELATED_CONTEXT/);
    assert.deepEqual(await page.locator("#reportPopulationNote").textContent(), analyticalScope);
    await inspectReportCopies(page);
    const copy = page.locator(".prompt-comparison").filter({ hasText: "Here are three synthetic" });
    await copy.locator(":scope > summary").click();
    await copy.getByText("Edit or omit this report copy", { exact: true }).click();
    await copy.locator("textarea").fill("Edited contextual reply for reviewer@example.invalid.");
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await expect(page.locator(".report-copy-inspection > summary")).toContainText("4 report copies");
    await expect(page.frameLocator(".report-frame").getByText("Edited contextual reply for [email identifier removed].", { exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 950 });
        await page.addStyleTag({ content: "html { font-size: 200%; }" });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        const frame = page.frameLocator(".report-frame");
        await frame.locator("html").evaluate(node => { node.style.fontSize = "200%"; });
        assert.equal(await frame.locator("body").evaluate(node => node.scrollWidth <= node.ownerDocument.documentElement.clientWidth + 1), true);
        assert.equal(await frame.locator("#recorded-context pre").evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
        if (process.env.WIRE_REPORT_CONTEXT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_CONTEXT_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, `context-review-${theme}-375-200.png`), fullPage: true });
            await page.locator(".report-frame").scrollIntoViewIfNeeded();
            await frame.locator("#recorded-context").scrollIntoViewIfNeeded();
            await page.locator(".report-document").screenshot({ path: path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, `context-document-${theme}-375-200.png`) });
        }
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.locator("input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(store)).exports.length, 0, "Disclosure approval does not save files");
    await page.getByRole("button", { name: /Save locally/, exact: false }).last().click();
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    const saved = await (await savedResponse).json();
    const state = await loadBoardState(store);
    assert.equal(state.exports.length, 1);
    const frozen = JSON.parse(await readFile(state.exports[0].files["product-report.json"], "utf8"));
    assert.equal(frozen.records.length, 1);
    assert.match(JSON.stringify(frozen.recordedContext), /Edited contextual reply/);
    assert.doesNotMatch(JSON.stringify(frozen.recordedContext), /reviewer@example|UNRELATED_CONTEXT/);
    assert.deepEqual(state.exports[0].scenarioIds, [records[1].scenarioId]);
    assert.deepEqual(state.evidence, before.evidence);
    assert.deepEqual(state.personalEvaluation, before.personalEvaluation);
    assert.equal(Boolean(saved.error), false);
    assert.equal(forbidden, 0); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    assert.equal(requests.includes("/api/assessment/evidence"), false, "A reader visit is not needed to propose report context");
    await reportContents(page);
    await page.locator("[name=promptMode][value=none]").check();
    assert.equal(await contextOption.isDisabled(), true);
});

for (const change of ["consent", "context-source", "edited-consent", "stale-status", "saving-consent", "late-preview"]) test(`context review authority: ${change}`, { timeout: 30000 }, async t => {
    const cleanup = [];
    const { context: store, records } = await reportContextFixture({ after: action => cleanup.push(action) });
    let server, browser, releaseSave;
    t.after(async () => {
        releaseSave?.();
        try { await browser?.close(); await server?.close(); }
        finally { for (const action of cleanup) await action(); }
    });
    server = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const failedReads = [];
    page.on("response", response => {
        if (response.status() >= 400) failedReads.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    page.setDefaultTimeout(7000);
    await page.goto(server.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#activityList .request-row").filter({ hasText: "Three synthetic documents" }).locator("input[type=checkbox]").check();
    await navigateMain(page, "reports");
    await openReportCreation(page);
    await page.locator("#reportRecordedContext").check();
    if (change === "late-preview") {
        let produced;
        const prepared = new Promise(resolve => { produced = resolve; });
        await page.route("**/api/preview", async route => {
            const response = await route.fetch();
            produced();
            await new Promise(resolve => { releaseSave = resolve; });
            await route.fulfill({ response });
        });
        const delivered = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#exportBtn").click();
        await prepared;
        await updateBoardState(store, state => {
            state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
                categories: [], revokedAt: "2026-10-01T00:00:00.000Z" };
        });
        const expectedRevision = (await loadBoardState(store)).revision;
        const status = page.waitForResponse(async response => response.url().endsWith("/api/collection/status")
            && (await response.json()).revision === expectedRevision);
        await (await status).finished();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "draft");
        releaseSave();
        await (await delivered).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator("#reportReviewBody .report-frame").count(), 0);
        assert.doesNotMatch(await page.locator("#reportReviewBody").textContent(), /Here are three synthetic|reply@example.invalid/);
        assert.equal((await loadBoardState(store)).exports.length, 0);
        return;
    }
    const preview = await scanReport(page);
    if (change === "edited-consent") {
        await inspectReportCopies(page);
        for (const [source, text] of [["Three synthetic documents are enough.", "KEEP_PROMPT_EDIT"], ["Here are three synthetic", "SOURCE_BOUND_REPLY_EDIT"]]) {
            const copy = page.locator(".prompt-comparison").filter({ hasText: source });
            if (!await copy.evaluate(node => node.open)) await copy.locator(":scope > summary").click();
            await copy.getByText("Edit or omit this report copy", { exact: true }).click();
            await copy.locator("textarea").fill(text);
        }
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    }
    await page.locator("input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    if (change === "stale-status") {
        await page.route("**/api/collection/status", async route => {
            const response = await route.fetch(), value = await response.json();
            value.revision = preview.revision - 1;
            value.assessment.basis.consentRevision = 0;
            await route.fulfill({ response, json: value });
        });
        const delivered = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
        await (await delivered).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
        assert.equal(await page.locator("#reportReviewBody .report-frame").count(), 1);
        return;
    }
    if (change === "saving-consent") {
        let observed;
        const written = new Promise(resolve => { observed = resolve; });
        await page.route("**/api/export", async route => {
            const response = await route.fetch();
            observed();
            await new Promise(resolve => { releaseSave = resolve; });
            await route.fulfill({ response });
        });
        await page.getByRole("button", { name: /Save locally/, exact: false }).last().click();
        await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
        await written;
    }
    if (change !== "context-source") await updateBoardState(store, state => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
            categories: [], revokedAt: "2026-10-01T00:00:00.000Z" };
    });
    else {
        const state = await loadBoardState(store);
        await replaceEvidence(store, () => ({ records: state.evidence.map(record => record.scenarioId === records[0].scenarioId
            ? { ...record, userPrompt: { ...record.userPrompt, text: "Changed preceding context" } } : record), importCoverage: state.importCoverage }));
    }
    const expectedRevision = (await loadBoardState(store)).revision;
    const status = page.waitForResponse(async response => response.url().endsWith("/api/collection/status")
        && (await response.json()).revision === expectedRevision);
    await status;
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", change === "saving-consent" ? "writing" : "draft");
    assert.equal(await page.locator("#reportReviewBody .report-frame").count(), 0);
    assert.doesNotMatch(await page.locator("#reportReviewBody").textContent(), /Here are three synthetic|reply@example.invalid/);
    assert.equal((await loadBoardState(store)).exports.length, change === "saving-consent" ? 1 : 0);
    if (change === "saving-consent") {
        releaseSave();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        assert.equal((await loadBoardState(store)).exports.length, 1);
    }
    if (change === "edited-consent") {
        await reportContents(page);
        const snapshot = page.waitForResponse(async response => response.url().endsWith("/api/snapshot")
            && (await response.json()).revision === expectedRevision);
        await snapshot;
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const rebuilt = await scanReport(page);
        assert.equal(rebuilt.promptReview.some(copy => copy.text === "KEEP_PROMPT_EDIT"), true);
        assert.doesNotMatch(JSON.stringify(rebuilt), /SOURCE_BOUND_REPLY_EDIT/);
        assert.equal(rebuilt.snapshot.recordedContext.entries.filter(copy => copy.kind === "response").every(copy => copy.text === null), true);
    }
    assert.deepEqual(failedReads, []);
});
