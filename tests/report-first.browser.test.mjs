import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { time } from "../lib/time.mjs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

function records() {
    return Array.from({ length: 8 }, (_, index) => {
        const record = fixture(`report-first-${index}`);
        record.capturedAt = new Date().toISOString();
        record.toolCalls[0].startedAt = record.capturedAt;
        record.userPrompt.text = `REPORT_FIRST_${index} Find mailbox messages for email@example.invalid.`;
        record.toolCalls[0].toolSucceeded = index < 2 ? false : true;
        record.toolCalls[0].reportedOutcome = index < 2 ? "failed" : "succeeded";
        record.toolCalls[0].apiResults = [{ index: 0, statusCode: index < 2 ? 403 : 200 }];
        return record;
    });
}
async function setup(t, { source = records(), route = "#reports?task=create", enforced = false } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, source);
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, ...(access ? { access } : {}) });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); await access?.close(); for (const work of cleanup) await work(); });
    const profile = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const page = await profile.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    await page.goto(runtime.url + route);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.deepEqual(errors, []);
    return { page, context, source, errors, requests, runtime };
}
async function prepare(page, preset = "errors") {
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator(`[data-report-preset="${preset}"]`).click();
    const result = await response, body = await result.json();
    assert.equal(result.status(), 200, body.error);
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeVisible();
    return body;
}

test("gallery opens a real report and direct Save preserves the frozen failure cohort", { timeout: 60000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t);
    await expect(page.locator("[data-report-preset]")).toHaveCount(5);
    await expect(page.locator(".report-progress")).toBeHidden();
    const initial = await prepare(page);
    assert.equal(initial.snapshot.reportPopulation.reference.length, 8);
    assert.equal(initial.records.length, 2);
    assert.equal(initial.promptMode, "masked");
    assert.equal(await page.locator(".report-approval .attestation").count(), 0);
    await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Errors & failures");
    const state = await loadBoardState(context), added = fixture("arrived-after-preview");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Mailbox call failures");
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();
    await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Mailbox call failures");
    const updated = await (await rebuilt).json();
    assert.deepEqual(updated.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "HTML", exact: true }).click();
    let preparedFiles = updated.files;
    for (const format of ["pdf", "json", "markdown"]) {
        const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const result = await response, body = await result.json();
        assert.equal(result.status(), 200, body.error);
        assert.deepEqual(body.snapshot.reportPopulation, initial.snapshot.reportPopulation);
        preparedFiles = body.files;
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    const save = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).dblclick();
    assert.equal((await save).status(), 200);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = await loadBoardState(context);
    assert.equal(saved.exports.length, 1);
    assert.equal(saved.exports[0].privacyReview.reviewerConfirmed, false);
    assert.equal(requests.filter(request => request.path === "/api/privacy-review").length, 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    for (const [format, name] of [["html", "product-report.html"], ["pdf", "product-report.pdf"], ["json", "product-report.json"], ["markdown", "product-report.md"]]) {
        if (format !== "html") {
            await page.getByRole("combobox", { name: "Report format", exact: true }).click();
            await page.locator(`.select-popup [data-value="${format}"]`).click();
        }
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const file = await download, bytes = await readFile(await file.path());
        const expected = typeof preparedFiles[name] === "string" ? Buffer.from(preparedFiles[name]) : Buffer.from(preparedFiles[name].data, "base64");
        assert.deepEqual(bytes, expected);
    }
    assert.deepEqual(errors, []);
});

test("fresh reports ignore Analyze restrictions and custom dates replace only an explicit Current period", { timeout: 60000 }, async t => {
    const source = records();
    const today = time.day(new Date().toISOString(), "America/Los_Angeles");
    const prior = new Date(Date.now() - 10 * 86400000).toISOString();
    source[0].capturedAt = prior; source[0].toolCalls[0].startedAt = prior;
    for (const record of source.slice(0, 3)) {
        record.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
        record.toolCalls[0].requestedApiPath = "/me/messages";
    }
    const route = `#reports?task=create&service=Mail&range=custom&from=${today}&to=${today}`;
    const { page, errors } = await setup(t, { source, route });
    const fresh = await prepare(page, "all");
    assert.equal(fresh.records.length, 7, "Fresh scope includes Calendar despite the old Mail filter");
    await page.getByRole("button", { name: "Choose another report", exact: true }).click();
    await page.locator(".report-explicit-selection>summary").click();
    await page.locator('[name=reportScope][value=current]').check();
    const current = await prepare(page, "all");
    assert.equal(current.records.length, 2);
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.locator("#reportPeriodChoices [data-report-range=custom]").click();
    await expect(page.locator("#reportCustomDates")).toBeVisible();
    assert.equal(await page.locator("#reportCustomDates [data-report-range]").count(), 0);
    await page.locator("#reportCustomDates").getByLabel("From", { exact: true }).fill("2026-01-01");
    await page.locator("#reportCustomDates").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.frameLocator(".report-frame").locator("[data-report-scenario]").count(), 2);
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.locator("#reportPeriodChoices [data-report-range=custom]").click();
    await page.locator("#reportCustomDates").getByLabel("From", { exact: true }).fill("2026-01-01");
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Use dates", exact: true }).click();
    const widened = await response, body = await widened.json();
    assert.equal(widened.status(), 200, body.error);
    assert.equal(body.records.length, 3, "Mail is retained and the original older interaction is admitted");
    await expect(page.locator("#reportExperienceScope")).toContainText("Based on Analyze filters");
    assert.match(page.url(), new RegExp(`from=${today}&to=${today}`), "Analyze dates were not mutated");
    assert.deepEqual(errors, []);
});

test("a lost direct-Save response recovers the original exact-content receipt without a second write", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    const preview = await prepare(page);
    await page.route("**/api/export", async route => { await route.fetch(); await route.abort("connectionreset"); }, { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
    assert.equal((await loadBoardState(context)).exports.length, 1);
    await page.getByRole("button", { name: "Check save status", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports[0];
    assert.equal(saved.bundleId, preview.bundleId);
    assert.equal(saved.privacyReview.localSave.contentHash, preview.localSaveRequest.contentHash);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.deepEqual(errors, []);
});

test("new library metadata and saved comparisons use frozen files and direct local Save", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    for (const preset of ["errors", "all"]) {
        await prepare(page, preset);
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        if (preset === "errors") await page.getByRole("button", { name: "Start a new report", exact: true }).click();
    }
    await page.locator("#reportLibraryLink").click();
    await expect(page.locator(".saved-report-purpose")).toHaveCount(2);
    await expect(page.locator(".saved-report-purpose").first()).toContainText("Personal details hidden where detected");
    await page.locator("#reportCompareLink").click();
    const entries = (await loadBoardState(context)).exports;
    for (const [label, id] of [["Earlier report", entries[0].bundleId], ["Later report", entries[1].bundleId]]) {
        await page.getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup [data-value="${id}"]`).click();
    }
    const preparation = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await page.getByRole("button", { name: "Compare reports", exact: true }).click();
    const prepared = await preparation, body = await prepared.json();
    assert.equal(prepared.status(), 200, body.error);
    await expect(page.getByRole("button", { name: "Approve for local saving", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Save comparison", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open saved comparison", exact: true })).toBeVisible();
    const comparison = (await loadBoardState(context)).exports.find(entry => entry.kind === "comparison");
    assert.equal(comparison.privacyReview.reviewerConfirmed, false);
    assert.equal(comparison.privacyReview.localSave.contentHash, body.localSaveRequest.contentHash);
    assert.equal(requests.filter(request => /\/(?:privacy-review|report-comparison\/review)$/.test(request.path)).length, 0);
    assert.deepEqual(errors, []);
});

test("retained-period comparison opens its report directly and saves the accepted pair", { timeout: 60000 }, async t => {
    const { page, context, errors } = await setup(t, { source: periodFixture().records, route: "#analyze" });
    await page.locator("#comparePeriods").click();
    for (const [label, value] of [["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"]]) {
        await page.getByLabel(label, { exact: true }).fill(value);
    }
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#createPeriodReport").click();
    const response = await pending, prepared = await response.json();
    assert.equal(response.status(), 200, prepared.error);
    assert.ok(prepared.snapshot.periodComparison);
    assert.equal(prepared.localSaveRequest.version, 1);
    await expect(page.locator("#reportStage3")).toBeVisible();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal((await loadBoardState(context)).exports[0].reportType, "period-comparison");
    assert.deepEqual(errors, []);
});

test("access withdrawal erases held example editors and never resumes their old save intent", { timeout: 30000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t, { enforced: true });
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-example-editor summary").first().click();
    const note = frame.getByLabel("Your note", { exact: true }).first();
    await note.fill("PRIVATE_UNSAVED_NOTE");
    await page.evaluate(() => {
        const source = document.querySelector(".report-frame").contentDocument;
        window.heldReportNote = source.querySelector(".wire-example-editor textarea");
        window.heldReportTitle = source.querySelector("h1").firstChild;
    });
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await page.evaluate(() => window.heldReportNote.value), "");
    assert.equal(await page.evaluate(() => window.heldReportTitle.data), "");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 0);
    assert.deepEqual(errors, []);
});

test("keep-details warning can cancel or regenerate masked notes and copies before one Save", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Your note", { exact: true }).first().fill("Expected a result for note@example.invalid.");
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update note", exact: true }).first().click();
    assert.equal((await response).status(), 200);
    await page.getByRole("button", { name: "Hide personal details", exact: true }).click();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check();
    assert.equal((await response).status(), 200);
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Hide details and save", exact: true }).click();
    const result = await saved;
    assert.equal(result.status(), 200, JSON.stringify(await result.json()));
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(context);
    assert.equal(state.exports.length, 1);
    assert.equal(state.exports[0].promptMode, "masked");
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.equal(requests.filter(request => request.path === "/api/privacy-review").length, 0);
    assert.deepEqual(errors, []);
});

test("returning to the gallery during preparation retires that result and leaves report choices usable", { timeout: 30000 }, async t => {
    const { page, context, errors } = await setup(t);
    const held = Promise.withResolvers();
    await page.route("**/api/preview", async route => { const response = await route.fetch(); await held.promise; await route.fulfill({ response }); }, { times: 1 });
    await page.locator('[data-report-preset="errors"]').click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "scanning");
    await page.getByRole("button", { name: "Choose another report", exact: true }).click();
    held.resolve();
    await expect(page.locator('[data-report-preset="errors"]')).toBeEnabled();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await prepare(page);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("report-first controls retain equal geometry, readable themes and narrow enlarged-text access", { timeout: 60000 }, async t => {
    const { page, errors } = await setup(t);
    const proofs = process.env.WIRE_REPORT_FIRST_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    async function capture(name) {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name);
        if (proofs) await page.screenshot({ path: path.join(proofs, name + ".png") });
    }
    await page.locator('[data-report-preset="errors"]').hover();
    await expect(page.getByRole("tooltip")).toBeHidden();
    await page.getByRole("button", { name: "About errors & failures", exact: true }).click();
    await expect(page.getByRole("tooltip")).toBeVisible();
    const help = await page.getByRole("button", { name: "About errors & failures", exact: true }).boundingBox();
    const tip = await page.getByRole("tooltip").boundingBox();
    const distance = Math.hypot(Math.max(tip.x - help.x - help.width, help.x - tip.x - tip.width, 0),
        Math.max(tip.y - help.y - help.height, help.y - tip.y - tip.height, 0));
    assert.ok(distance <= help.height, JSON.stringify({ help, tip, distance }));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    for (const [theme, width, size] of [["light", 1280, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
        const heights = await page.locator(".report-tile").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.ok(heights.every(height => Math.abs(height - heights[0]) < 1));
        await capture(`gallery-${theme}-${width}-${size}`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator("#reportGallery [data-report-range=custom]").click();
    await expect(page.locator("#reportCustomDates")).toBeVisible();
    await capture("calendar-dark-1280");
    await page.keyboard.press("Escape");
    await prepare(page);
    for (const [theme, width, size] of [["dark", 1280, 100], ["light", 1280, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; scrollTo(0, 0); }, size);
        const name = page.getByLabel("Report name", { exact: true });
        await name.focus();
        const gap = await name.evaluate(node => node.getBoundingClientRect().top - node.previousElementSibling.getBoundingClientRect().bottom);
        assert.ok(gap >= 8);
        await capture(`report-${theme}-${width}-${size}`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.getByRole("button", { name: "Hide personal details", exact: true }).click();
    const ready = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check(); await ready;
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const buttons = await page.locator(".report-warning-actions>button:not(.report-warning-back)").evaluateAll(nodes =>
        nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    assert.deepEqual(buttons[0], buttons[1]);
    await capture("warning-dark-375");
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.deepEqual(errors, []);
});
