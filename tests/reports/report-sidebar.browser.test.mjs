import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, navigateMain, revealAnalyzeRecords } from "../support/helpers.mjs";
import { prepareReportPreview, selectReportFocus, openReportLibrary } from "./report-journey-helpers.mjs";

async function setup(t, { width = 1440, height = 1000, touch = false, recordCases } = {}) {
    const records = recordCases ?? Array.from({ length: 9 }, (_, index) => {
        const value = fixture(`report-sidebar-${index}`);
        value.capturedAt = value.toolCalls[0].startedAt = new Date(Date.now() - index * 1000).toISOString();
        value.userPrompt = { text: `Invented report question${index}: retain the release decisions and the unresolved calendar follow-up.`,
            status: "full", sourceTimestamp: value.capturedAt, sourceEventId: `report-prompt-${index}`,
            authorship: { actor: "user", basis: "source-user" } };
        value.sourceSessionName = `Invented report chat ${index}`;
        value.followUpPrompts = [];
        return value;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: new URL(request.url()), method: request.method(),
        body: request.method() === "POST" ? request.postDataJSON() : null }));
    await page.route("**/api/assessment/evaluate", route => route.abort("blockedbyclient"));
    await page.route("**/api/collection/refresh", route => route.abort("blockedbyclient"));
    await page.addInitScript(() => {
        window.reportCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) { window.reportCopies.push(text); },
        } });
    });
    t.after(async () => {
        await browser.close();
        await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => request.url.origin === new URL(runtime.url).origin), "No off-device requests");
        assert.equal(requests.filter(request => /\/(?:evaluate|refresh)$/.test(request.url.pathname)).length, 0);
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, context, records, requests };
}

const picker = page => page.locator("#reportActivityOptions");
const button = (root, name) => root.getByRole("button", { name, exact: true });
const sent = (requests, path) => requests.filter(r => r.url.pathname === path).map(r => r.body);
async function openPicker(page, scope = "selected") {
    await page.locator("#reportDeskActivity").click();
    await picker(page).locator(`[name=reportScope][value=${scope}]`).check();
}
async function previewFrom(page, action) {
    const [res] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/preview")), action()]);
    const preview = await res.json();
    assert.ok(res.ok(), preview.error);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    return preview;
}

test("the report name belongs to the prepared selection; Back, resume and file reading grant no approval", async t => {
    const { page, context, requests } = await setup(t);
    await navigateMain(page, "reports");
    await selectReportFocus(page, "all");
    await openPicker(page);
    const selected = ["report-sidebar-0", "report-sidebar-1"];
    for (const id of selected) await picker(page).locator(`[data-report-request="${id}"]`).check();
    await button(picker(page), "Use activity").click();
    await page.getByRole("button", { name: /^Formats:/ }).click();
    await page.locator("#formatOptions input[value=json]").check();
    await page.keyboard.press("Escape");
    assert.deepEqual(sent(requests, "/api/preview"), []);
    const initial = await previewFrom(page, () => prepareReportPreview(page));
    assert.deepEqual(sent(requests, "/api/preview")[0].selection.scenarioIds.sort(), selected);
    const name = page.getByLabel("Report name", { exact: true });
    const edited = await previewFrom(page, () => name.fill("Calendar planning review"));
    assert.notEqual(edited.previewId, initial.previewId);
    assert.equal(edited.title, "Calendar planning review");
    assert.deepEqual(edited.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#prepareReportPreview")).toBeFocused();
    await expect(page.locator("#prepareReportPreview")).toHaveAccessibleName("Resume preview");
    await prepareReportPreview(page);
    await expect(name).toHaveValue(edited.title);
    await selectActivityOption(page, "preparedReportView", "product-report.json");
    await expect(page.locator("#reportFileInspection")).toContainText(edited.title);
    assert.equal(sent(requests, "/api/preview").length, 2);
    assert.deepEqual(sent(requests, "/api/privacy-review"), []);
    assert.deepEqual(sent(requests, "/api/export"), []);
    assert.deepEqual((await loadBoardState(context)).exports, []);
});

test("a title-mismatched Save response can only recover the dispatched report, never replay or approve it", async t => {
    const { page, context, requests } = await setup(t);
    await navigateMain(page, "reports"); await selectReportFocus(page, "all");
    await previewFrom(page, () => prepareReportPreview(page));
    const preview = await previewFrom(page, () => page.getByLabel("Report name", { exact: true }).fill("Planning receipt identity"));
    await page.route("**/api/export", async route => {
        const response = await route.fetch(), result = await response.json();
        result.bundle.title = "Not this report"; await route.fulfill({ response, json: result });
    }, { times: 1 });
    await button(page, "Save report").click();
    await expect(button(page, "Check save status")).toBeEnabled();
    await expect(page.locator(".report-save-success")).toHaveCount(0);
    const saved = (await loadBoardState(context)).exports;
    assert.deepEqual(saved.map(b => [b.bundleId, b.title, b.privacyReview.reviewerConfirmed]), [[preview.bundleId, preview.title, false]]);
    await button(page, "Check save status").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await button(page, "Open saved report").click();
    await expect(page.getByRole("region", { name: preview.title, exact: true }).getByRole("heading", { level: 1 })).toHaveText(preview.title);
    await expect(page.getByRole("article", { name: "Report brief" })).toContainText("9 interactions");
    assert.deepEqual(sent(requests, "/api/export").map(r => r.previewId), [preview.previewId]);
    assert.equal(sent(requests, "/api/report/open").at(-1).bundleId, preview.bundleId);
    assert.equal(await readFile(saved[0].files["product-report.html"], "utf8"), preview.files["product-report.html"]);
    assert.deepEqual(sent(requests, "/api/privacy-review"), []);
    assert.deepEqual(await page.evaluate(() => window.reportCopies), []);
});

for (const scope of ["all", "current", "selected"]) test(`opening an interaction from the ${scope} Reports picker preserves exact choices and its return anchor`, async t => {
    const { page, requests, context } = await setup(t);
    await navigateMain(page, "reports"); await selectReportFocus(page, "all");
    await openPicker(page, scope);
    const options = picker(page);
    if (scope === "selected") await options.locator('[data-report-request="report-sidebar-0"]').check();
    await options.getByRole("button", { name: "Next report requests", exact: true }).click();
    const row = options.locator('[data-view-key="report:report-sidebar-4"]'), opener = row.locator(".recognition-row");
    if (scope === "selected") await row.getByRole("checkbox").check();
    await options.locator("#reportRequestSearch").fill("question4");
    const address = page.url(); await opener.focus();
    const top = await options.locator(".report-selection-body").evaluate(n => n.scrollTop);
    await opener.press("Enter");
    await expect(page.locator("#requestContent")).toContainText("question4");
    await page.goBack();
    await expect(page).toHaveURL(address); await expect(opener).toBeFocused();
    await expect(options.locator("#reportRequestSearch")).toHaveValue("question4");
    await expect(options.locator("[name=reportScope]:checked")).toHaveValue(scope);
    await expect.poll(() => options.locator(".report-selection-body").evaluate(n => n.scrollTop)).toBe(top);
    if (scope === "selected") await expect(row.getByRole("checkbox")).toBeChecked();
    await button(options, "Use activity").click();
    await expect(page.locator("#reportDeskActivity")).toBeFocused();
    assert.deepEqual(sent(requests, "/api/preview"), []);
    const preview = await previewFrom(page, () => prepareReportPreview(page));
    const actual = sent(requests, "/api/preview").at(-1).selection;
    assert.equal(actual.kind, scope);
    if (scope === "selected") assert.deepEqual(actual.scenarioIds.sort(), ["report-sidebar-0", "report-sidebar-4"]);
    assert.equal(preview.records.length, scope === "selected" ? 2 : 9);
    assert.deepEqual((await loadBoardState(context)).exports, []);
});

test("Back from the Reports picker reader retires late reads and detached Copy handlers", async t => {
    const { page, requests } = await setup(t);
    await navigateMain(page, "reports"); await openPicker(page);
    for (const mode of ["auto", "manual"]) {
        await page.evaluate(value => { history.scrollRestoration = value; }, mode);
        const release = Promise.withResolvers(); t.after(() => release.resolve());
        await page.route("**/api/assessment/detail", async route => {
            const response = await route.fetch(); await release.promise; await route.fulfill({ response });
        }, { times: 1 });
        const pending = page.waitForRequest(r => r.url().endsWith("/api/assessment/detail"));
        const opener = picker(page).locator(".recognition-row").first(); await opener.click(); const request = await pending;
        const copy = await page.getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
        await page.goBack(); await expect(opener).toBeFocused();
        release.resolve(); await request.response();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        await copy.evaluate(n => n.click()); assert.deepEqual(await page.evaluate(() => window.reportCopies), []);
    }
    assert.deepEqual(sent(requests, "/api/preview"), []); assert.deepEqual(sent(requests, "/api/export"), []);
});

test("Search from the saved library opens the exact interaction and Continue prepares only that selection", async t => {
    const { page, requests } = await setup(t);
    await navigateMain(page, "reports"); await openReportLibrary(page);
    await page.locator("#wireSearch").fill("question8");
    const hit = page.locator('#wireSearchResults [data-search-category="interaction"] .wire-search-hit').first();
    await hit.press("Enter");
    await expect(page.locator("#requestContent")).toContainText("question8");
    await expect(page.locator("#requestReportContinue")).toBeDisabled();
    await page.locator("#requestReportToggle").click();
    assert.deepEqual(sent(requests, "/api/preview"), []);
    const preview = await previewFrom(page, () => page.locator("#requestReportContinue").click());
    assert.equal(preview.records.length, 1);
    assert.deepEqual(sent(requests, "/api/preview").at(-1).selection.scenarioIds, ["report-sidebar-8"]);
    assert.deepEqual(sent(requests, "/api/export"), []);
});

test("responsive adaptation preserves the main card anchor through narrow doubled text and back", { timeout: 20000 }, async t => {
    const { page } = await setup(t, { width: 1200 });
    await revealAnalyzeRecords(page);
    const card = page.locator(".request-card-open").first();
    await card.scrollIntoViewIfNeeded();
    const entry = await card.boundingBox();
    await page.mouse.click(entry.x + entry.width / 2, entry.y + entry.height / 2);
    for (const [width, scale] of [[375, 2], [1200, 1]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 16}px`, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const returned = await card.boundingBox();
    assert.ok(Math.abs(returned.y - entry.y) < 3, JSON.stringify({ before: entry.y, after: returned.y }));
    await page.locator("#closeContextSidebar").click();
    const closed = await card.boundingBox();
    assert.ok(Math.abs(closed.y - entry.y) < 3, JSON.stringify({ before: entry.y, after: closed.y }));
});

test("report picker inspection preserves exact retained prompt text and does not invent missing text", async t => {
    const cases = ["full", "agent-long", "partial", "missing"].map((name, index) => {
        const record = fixture("picker-" + name);
        record.sourceSessionName = "Invented picker chat";
        record.followUpPrompts = [];
        record.userPrompt = { text: "Find the invented calendar decision and its owner.", status: "full",
            sourceEventId: "picker-prompt-" + index, sourceTimestamp: "2026-09-30T12:00:00Z",
            authorship: { actor: "user", basis: "source-user" } };
        return record;
    });
    cases[1].userPrompt.text = "  Invented delegated planning request.\nKeep these exact spaces.  \n" + "Compare the fictional launch plans without collecting new history. ".repeat(14);
    cases[0].toolCalls.push({ ...fixture("picker-extra").toolCalls[0], toolSucceeded: false, reportedOutcome: "failed" });
    cases[1].userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    cases[1].toolCalls[0].toolSucceeded = false;
    cases[1].toolCalls[0].reportedOutcome = "failed";
    cases[2].userPrompt = { ...cases[2].userPrompt, text: "This retained fragment ends before the final question. ".repeat(5),
        status: "partial", sourceTimestamp: null, authorship: { actor: "unknown", basis: "missing-source" } };
    cases[2].toolCalls[0].startedAt = "2026-09-30T12:09:00Z";
    cases[3].userPrompt = { ...cases[3].userPrompt, text: null, status: "unavailable", sourceTimestamp: null };
    cases[3].toolCalls[0].toolSucceeded = undefined;
    cases[3].toolCalls[0].reportedOutcome = "unknown";
    const { page, requests } = await setup(t, { recordCases: cases });
    await navigateMain(page, "reports"); await openPicker(page);
    const item = name => picker(page).locator(`[data-view-key="report:picker-${name}"]`);
    await item("full").getByRole("checkbox").check();
    for (const [index, name] of ["agent-long", "partial", "missing"].entries()) {
        const opener = item(name).locator(".recognition-row");
        await opener.press("Enter");
        const subject = page.locator('[data-reader-section="prompt"]');
        if (name === "missing") {
            await expect(subject).toContainText(/not available|unavailable|no prompt/i);
            await expect(subject.getByRole("button", { name: "Copy prompt" })).toHaveCount(0);
        } else {
            await expect(subject.locator("pre")).toHaveText(cases[index + 1].userPrompt.text);
            if (name === "partial") await expect(subject).toContainText(/partial|part of the original/i);
        }
        await page.goBack(); await expect(opener).toBeFocused();
        await expect(item(name).getByRole("checkbox")).not.toBeChecked();
        await expect(item("full").getByRole("checkbox")).toBeChecked();
    }
    assert.deepEqual(sent(requests, "/api/preview"), []);
});
