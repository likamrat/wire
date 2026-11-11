import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";
import { timeoutRecord } from "./timing-outcome-fixture.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";

const cases = [
    ["timeout", "MCP server 'workiq': MCP error -32001: Request timed out", "failure", null, "completion-error", "allowed waiting interval"],
    ["upstream", "MCP server 'workiq': MCP request failed: Transport send error: Transport [InventedTransport] error: unexpected server response: HTTP 503 Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection timeout", "failure", null, "completion-error", "before response headers"],
    ["simple", "The field 'title' is required. Supply a non-empty title.", "BadRequest", 400, "workiq-error-json", null],
    ["unsupported", null, "UnmappedServiceFault", null, "completion-error", "no verified meaning"],
    ["access", "Access denied", "AccessDenied", 403, "workiq-error-json", "understood but refused"],
    ["policy", "The required policy is unavailable.", "PolicyUnavailable", null, "workiq-error-json", "policy configuration"],
    ["conflict", "Access denied", "AccessDenied", 500, "result-error", "statuses disagree"],
    ["processing", "Error while processing response.", "InternalServerError", null, "workiq-error-json", "signal alone"],
    ["hidden-error", "The response processor failed.", null, 200, "result-error", "statuses disagree"],
    ["non-error", "The response statuses differ.", null, 200, "result-error", "statuses disagree"],
];
function records() {
    const at = new Date(Date.now() - 86400000).toISOString();
    return cases.map(([id, message, code, statusCode, source]) => {
        const record = timeoutRecord(id, id === "timeout" ? 180024 : 1348, at), call = record.toolCalls[0];
        call.tool = "workiq-fetch";
        call.requestArgs = { entityUrls: ["/me/messages"] }; call.requestedApiPath = "/me/messages";
        call.failureEvidence = { version: 1, reason: "error-code-recorded", code, messageStatus: "text-excluded",
            diagnostic: { version: 1, status: "recorded", source, code,
                ...(message ? { message } : {}), ...(statusCode === null ? {} : { statusCode }) } };
        if (["conflict", "hidden-error", "non-error"].includes(id)) {
            call.reportedOutcome = "succeeded"; call.toolSucceeded = true;
            const diagnostic = { ...call.failureEvidence.diagnostic,
                statusCode: id === "conflict" ? 403 : id === "hidden-error" ? 500 : 201 };
            if (code === null) delete diagnostic.code;
            call.apiResults = [{ index: 0, statusCode, ...(code === null ? {} : { errorCode: code }), errorDiagnostic: diagnostic }];
            call.failureEvidence = null;
        }
        if (id === "processing") {
            Object.assign(call.failureEvidence, { messageSource: "workiq-error-json", messageSignal: "response-processing-error" });
            call.failureEvidence.diagnostic.details = [{ code: "InvalidResponse", message: "JSON parsing failed in the response adapter." }];
        }
        return record;
    });
}

test("cards, expanded readers and prepared formats distinguish source reasons from useful technical interpretation", { timeout: 90000 }, async t => {
    const cleanup = [], errors = [], denied = [], source = records();
    let runtime, browser;
    t.after(async () => {
        try { await browser?.close(); await runtime?.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); }
        finally { for (const work of cleanup) await work(); }
    });
    const { context } = await privateFixture({ after: work => cleanup.push(work) }, source);
    const before = await loadBoardState(context);
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1380, height: 1080 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/preview", "/api/cancel-preview"];
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    const folder = process.env.WIRE_ERROR_INTERPRETATION_PROOFS;
    async function capture(name) {
        if (!folder) return;
        await mkdir(folder, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(folder, name + ".png") });
    }
    await page.goto(runtime.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const [id, message, code, status, , meaning] of cases) {
        const card = page.locator(".request-card-open").filter({ hasText: `invented ${id} request` });
        if (!await card.count()) {
            await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        }
        if (meaning) await expect(card.locator('[data-interpretation="true"]')).toContainText(meaning);
        else {
            await expect(card.locator('[data-interpretation="true"]')).toHaveCount(0);
            await expect(card).toContainText(message);
        }
        await expect(card).toContainText("workiq-fetch");
        await expect(card).toContainText("/me/messages");
        await card.scrollIntoViewIfNeeded();
        if (id === "timeout") { await chooseTheme(page, "light"); await capture("timeout-card-light"); }
        await card.click();
        const call = page.locator(`[data-tool-call-id="${id}-call"]`);
        if (code !== null && code !== "failure") await expect(call).toContainText(code);
        if (status !== null) await expect(call).toContainText(String(status));
        const toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        if (meaning) {
            await expect(call.locator('[data-interpretation="true"]')).toBeVisible();
            await expect(call.locator('[data-interpretation="true"]')).toContainText(meaning);
        }
        if (message) await expect(call.locator(".reader-error-message").first()).toContainText(message);
        if (id === "conflict") {
            await expect(call).toContainText("403"); await expect(call).toContainText("500");
            await expect(call.locator('[data-interpretation="true"]')).not.toContainText("understood but refused");
            await expect(call.locator(".reader-call-summary [data-outcome]")).toHaveAttribute("data-outcome", "success");
        }
        if (id === "processing") {
            await expect(call).toContainText("JSON parsing failed in the response adapter.");
            await expect(call).not.toContainText("The record does not identify the processing step");
        }
        if (["conflict", "processing", "hidden-error", "non-error"].includes(id)) {
            await call.scrollIntoViewIfNeeded(); await capture(id + "-reader");
        }
        await expect(call).toContainText(id === "timeout" ? "180,024 ms (180.024 s)" : "1,348 ms (1.348 s)");
        if (id === "timeout") {
            await chooseTheme(page, "dark");
            await call.scrollIntoViewIfNeeded(); await capture("timeout-reader-dark");
        }
        await toggle.focus(); await page.keyboard.press("Enter");
        await expect(toggle).toBeFocused();
        if (meaning) await expect(call.locator('[data-interpretation="true"]')).toBeVisible();
        await page.locator("#closeContextSidebar").click();
    }
    await navigateMain(page, "reports");
    const waiting = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="errors"]').click();
    let response = await waiting, preview = await response.json();
    assert.equal(response.status(), 200, preview.error);
    assert.equal(preview.snapshot.resultFacts.calls.length, cases.length - 1);
    assert.equal(preview.snapshot.reportPopulation.reference.length, cases.length);
    const conflict = preview.snapshot.resultFacts.calls.find(call => call.observations[0].returnedEntries.some(entry => entry.statusConflict?.reported === 500));
    assert.equal(conflict.completion, "succeeded");
    assert.deepEqual(conflict.observations[0].returnedEntries[0].statusConflict, { version: 1, reported: 500, diagnostic: 403 });
    const hiddenError = preview.snapshot.resultFacts.calls.find(call => call.observations[0].returnedEntries.some(entry =>
        entry.statusConflict?.reported === 200 && entry.statusConflict.diagnostic === 500));
    assert.equal(hiddenError.completion, "succeeded");
    assert.equal(hiddenError.observations[0].returnedEntries[0].statusCode, 200);
    assert.equal(hiddenError.observations[0].returnedEntries[0].errorCode, null);
    assert.ok(!preview.snapshot.resultFacts.calls.some(call => call.observations[0].returnedEntries.some(entry => entry.statusConflict?.diagnostic === 201)));
    const frame = page.frameLocator(".report-contained-frame");
    for (const [, , , , , meaning] of cases) if (meaning) await expect(frame.locator("body")).toContainText(meaning);
    await expect(frame.locator("body")).toContainText("Recorded tool interval: 180,024 ms (180.024 s)");
    await expect(frame.locator("body")).toContainText("not downstream API latency");
    await expect(frame.locator("#patterns")).toContainText("Conflicting returned-entry statuses (reported: 200; diagnostic: 500)");
    await frame.locator('a[href$="#recorded-result-facts"]').click();
    await frame.getByText(/Returned API entry 1: diagnostic status 403/).scrollIntoViewIfNeeded();
    await capture("conflict-report");
    await frame.getByText(/Returned API entry 1: diagnostic status 500 conflicts with returned status 200/).scrollIntoViewIfNeeded();
    await capture("diagnostic-only-error-report");
    for (const [theme, width] of [["light", 1380], ["dark", 390]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1080 });
        await frame.locator('a[href$="#recorded-result-facts"]').click();
        await frame.getByText(/WIRE interpretation:.*allowed waiting interval/).scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.ok(await frame.locator("body").evaluate(body => body.scrollWidth <= innerWidth + 1));
        await capture("interpreted-report-" + theme);
    }
    await page.setViewportSize({ width: 1380, height: 1080 });
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const format of ["json", "markdown", "pdf"]) {
        const wait = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        response = await wait; preview = await response.json();
        assert.equal(response.status(), 200, preview.error);
    }
    for (const [name, content] of Object.entries(preview.files)) {
        const text = name.endsWith(".pdf") ? (await pdfDocumentText(Buffer.from(content.data, "base64"))).content.replace(/\s+/g, " ")
            : String(content).replaceAll("\\", "");
        for (const [, , , , , meaning] of cases) if (meaning) assert.ok(text.includes(meaning), name + ": " + meaning);
        assert.ok(text.includes("non-empty title"), name + " retains the self-explanatory original");
        assert.ok(text.includes("UnmappedServiceFault"), name + " retains disclosed unsupported code");
        assert.doesNotMatch(text, /retry automatically|server was slow/i);
        assert.doesNotMatch(text, /Next evidence to check|Next diagnostic check/);
        assert.ok(text.includes("JSON parsing failed in the response adapter."), name);
        assert.doesNotMatch(text, /The record does not identify the processing step/);
        if (!name.endsWith(".json")) assert.match(text, /diagnostic status 403 conflicts with returned status 500/i, name);
        if (!name.endsWith(".json")) assert.match(text, /Conflicting returned-entry statuses \(reported: 200; diagnostic: 500\)/, name);
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    const completedResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="completed"]').click();
    const completed = await (await completedResponse).json();
    assert.equal(completed.snapshot.resultFacts.calls.length, 1);
    assert.equal(completed.snapshot.resultFacts.calls[0].completion, "succeeded");
    assert.deepEqual(completed.snapshot.resultFacts.calls[0].observations[0].returnedEntries[0].statusConflict,
        { version: 1, reported: 200, diagnostic: 201 });
    assert.ok(completed.snapshot.reportPatterns.groups.every(group => group.kind !== "errors"));
    await expect(frame.locator("body")).toContainText("diagnostic status 201 conflicts with returned status 200");
    await capture("completed-non-error-conflict");
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.exports.length, 0, "Preparation does not save reports.");
});
