import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { chooseTheme, navigateMain, selectActivityOption } from "./helpers.mjs";
import { openReportCreation, reportContents, scanReport, inspectReportCopies, findReportCopy, selectAnalyzeRequest } from "./report-journey-helpers.mjs";

test("lost contextual report save keeps its unknown outcome and recovers without another disclosure or export", { timeout: 30000 }, async t => {
    const cleanup = [];
    const { context: store, records } = await reportContextFixture({ after: action => cleanup.push(action) });
    let server, browser;
    t.after(async () => {
        try { await browser?.close(); await server?.close(); }
        finally { for (const action of cleanup) await action(); }
    });
    server = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(7000);
    const requests = [], errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/assessment/evidence",
            "/api/evaluation/automatic/summary", "/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview", "/api/report/open"];
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.goto(server.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await selectAnalyzeRequest(page, page.locator("#activityList .request-row").filter({ hasText: "Three synthetic documents" }));
    await selectActivityOption(page, "serviceAssociationFilter", "Mail");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "reports"); await openReportCreation(page);
    await expect(page.locator("#reportPopulationNote")).toContainText("outside the current Analyze view");
    const membership = await page.locator("#previewSelectionSummary").textContent();
    await reportContents(page);
    await page.locator("#reportRecordedContext").check();
    for (const format of ["pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    await scanReport(page);
    await inspectReportCopies(page);
    const reply = await findReportCopy(page, "Here are three synthetic");
    await reply.getByText("Edit or omit this report copy", { exact: true }).click();
    await reply.locator("textarea").fill("Edited contextual reply for reviewer@example.invalid.");
    const earlier = await findReportCopy(page, "first@example.invalid");
    await earlier.getByText("Edit or omit this report copy", { exact: true }).click();
    await earlier.getByRole("checkbox", { name: "Omit this copy from the report", exact: true }).check();
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await page.locator("input[data-review-control]").check();
    const reviewResponse = page.waitForResponse(response => response.url().endsWith("/api/privacy-review"));
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    const reviewed = await (await reviewResponse).json();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(store)).exports.length, 0);
    await page.route("**/api/export", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).not.toHaveAttribute("data-report-phase", "writing");
    const saved = await loadBoardState(store);
    assert.equal(saved.exports.length, 1);
    assert.deepEqual(saved.exports[0].scenarioIds, [records[1].scenarioId]);
    await page.waitForResponse(async response => response.url().endsWith("/api/collection/status")
        && (await response.json()).revision === saved.revision);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    t.diagnostic(JSON.stringify({ phase: await page.locator("#reportsView").getAttribute("data-report-phase"),
        error: await page.locator("#reportJourneyError").textContent(), saved: saved.exports.length }));
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "blocked");
    assert.match(await page.locator("#reportJourneyError").textContent(), /may have completed|not confirmed|unknown/i);
    assert.doesNotMatch(await page.locator("#reportJourneyError").textContent(), /scope, source or review basis changed|scan again/i);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), membership);
    assert.equal(await page.locator("#reportCreateLink").textContent(), "Save status");
    assert.equal(await page.getByRole("button", { name: "1. Activity", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("#reportClearSelection").isDisabled(), true);
    await page.locator("#reportClearSelection").evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), membership);
    assert.equal(await page.locator("#reportReviewBody .report-frame").count(), 0, "Context invalidation still scrubs the preview after its authority changes");
    const mutations = () => requests.filter(item => ["/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview"].includes(item.path));
    const beforeRecovery = structuredClone(mutations());
    const retry = page.getByRole("button", { name: "Check save status", exact: true });
    assert.equal(await retry.isEnabled(), true);
    await page.setViewportSize({ width: 375, height: 950 });
    await retry.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    if (process.env.WIRE_REPORT_CONTEXT_PROOFS) {
        await mkdir(process.env.WIRE_REPORT_CONTEXT_PROOFS, { recursive: true });
        await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
        await page.screenshot({ path: path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, "lost-save-read-only-recovery-375.png"), fullPage: true });
    }
    await retry.click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await expect(page.locator("#savedLibraryTitle")).toHaveText("Saved reports (1)");
    assert.equal(await page.locator("#pageTitle").textContent(), saved.exports[0].title);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), membership);
    if (process.env.WIRE_REPORT_CONTEXT_PROOFS) {
        await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
        await page.screenshot({ path: path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, "lost-save-original-receipt-375.png"), fullPage: true });
    }
    assert.deepEqual(mutations(), beforeRecovery, "Recovery only reads the original outcome, never rescans, reapproves or replays");
    assert.equal(requests.filter(item => item.path === "/api/export").length, 1);
    assert.equal(requests.filter(item => item.path === "/api/privacy-review").length, 1);
    assert.equal(requests.filter(item => item.path === "/api/preview").length, 2, "Only the original scan and deliberate copy-edit rebuild");
    assert.equal((await loadBoardState(store)).exports.length, 1);
    assert.equal(await page.locator("#reportClearSelection").isEnabled(), true);
    const frozen = JSON.parse(await readFile(saved.exports[0].files["product-report.json"], "utf8"));
    assert.equal(frozen.records.length, 1);
    assert.match(JSON.stringify(frozen.recordedContext), /Edited contextual reply for \[email identifier removed\]/);
    assert.doesNotMatch(JSON.stringify(frozen), /reviewer@example|first@example|UNRELATED_CONTEXT/);
    assert.ok(frozen.recordedContext.entries.some(entry => entry.omitted));
    for (const [name, file] of Object.entries(saved.exports[0].files)) {
        const bytes = await readFile(file);
        const expected = reviewed.files[name];
        assert.deepEqual(bytes, typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected.data, "base64"), name);
    }
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("bundle"), saved.exports[0].bundleId);
    await page.locator("#savedReportReader iframe").waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
});

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
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/assessment/evidence",
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
    await page.locator("#pageAction").click();
    const row = page.locator("#reportList .report-entry").filter({ hasText: "Three synthetic documents" });
    await row.locator("input[type=checkbox]").check();
    await navigateMain(page, "analyze");
    await selectActivityOption(page, "serviceAssociationFilter", "Mail");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "reports");
    await openReportCreation(page);
    await expect(page.locator("#previewSelectionSummary")).toContainText("1 interaction");
    await expect(page.locator("#reportPopulationNote")).toContainText("outside the current Analyze view");
    const analyticalScope = await page.locator("#reportPopulationNote").textContent();
    await reportContents(page);
    const contextOption = page.locator("#reportRecordedContext");
    assert.equal(await contextOption.isChecked(), false, "Context requires a deliberate Setup choice");
    await contextOption.focus();
    await page.keyboard.press("Space");
    assert.equal(await contextOption.isChecked(), true);
    assert.equal(await page.locator("#promptOptions #reportRecordedContext").count(), 0,
        "Context help must not stretch every equal-height prompt-mode row");
    const enlargedSetup = await page.addStyleTag({ content: "html { font-size: 200%; }" });
    for (const theme of ["light", "dark"]) {
        await page.locator("#closeContextSidebar").click();
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 950 });
        await reportContents(page);
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
    const copy = await findReportCopy(page, "Here are three synthetic");
    await copy.getByText("Edit or omit this report copy", { exact: true }).click();
    await copy.locator("textarea").fill("Edited contextual reply for reviewer@example.invalid.");
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await expect(page.getByRole("tab", { name: "Text (4)", exact: true })).toBeVisible();
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
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(store)).exports.length, 0, "Disclosure approval does not save files");
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).click();
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
    await selectAnalyzeRequest(page, page.locator("#activityList .request-row").filter({ hasText: "Three synthetic documents" }));
    await navigateMain(page, "reports");
    await openReportCreation(page);
    await reportContents(page);
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
            const copy = await findReportCopy(page, source);
            await copy.getByText("Edit or omit this report copy", { exact: true }).click();
            await copy.locator("textarea").fill(text);
        }
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    }
    await page.locator("input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
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
        await page.getByRole("button", { name: "Save report", exact: true }).click();
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
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const rebuilt = await scanReport(page);
        assert.equal(rebuilt.revision, expectedRevision, "The fresh preview uses the accepted current state, whether its read finished before or after Back");
        assert.equal(rebuilt.promptReview.some(copy => copy.text === "KEEP_PROMPT_EDIT"), true);
        assert.doesNotMatch(JSON.stringify(rebuilt), /SOURCE_BOUND_REPLY_EDIT/);
        assert.equal(rebuilt.snapshot.recordedContext.entries.filter(copy => copy.kind === "response").every(copy => copy.text === null), true);
    }
    assert.deepEqual(failedReads, []);
});
