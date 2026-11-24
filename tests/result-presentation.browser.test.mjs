import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

function source(id = "result-card", route = "/me/messages") {
    const record = fixture(id);
    record.userPrompt.text = "Synthetic result presentation.";
    record.toolCalls[0].requestArgs = { entityUrls: [route] };
    record.toolCalls[0].requestedApiPath = route;
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 204, evidenceLevel: "intermediary-reported" }];
    return record;
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, records) {
    const before = JSON.stringify(records);
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() !== "GET" && !(request.method() === "POST" && ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(new URL(request.url()).pathname))) mutations.push(request.url());
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard reads in result tests."); },
        writeText() { throw Error("No clipboard writes in result tests."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
        assert.equal(JSON.stringify(records), before);
    });
    return { page, url: runtime.url };
}
async function outcomes(node) {
    return node.locator(".recorded-result").evaluateAll(nodes =>
        Object.fromEntries(nodes.map(n => [n.dataset.outcome, Number(n.dataset.count)])));
}

test("the completed call owns its selectable input path; the returned entry owns its reported HTTP 204", async t => {
    const record = source();
    const { page, url } = await setup(t, [record]);
    await page.goto(url + "#request?request=result-card"); await ready(page);
    const card = page.locator(`[data-tool-call-id="${record.toolCalls[0].toolCallId}"]`);
    const toggle = card.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(card.locator(".reader-call-summary .card-outcome-label")).toHaveText("1 tool call completed");
    await expect(card.locator(".reader-tool-name")).toHaveText("workiq-fetch");
    await expect(card.locator(".reader-call-services")).toContainText("Mail");
    const entry = card.locator(".api-result-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry.locator(".recorded-result-label")).toContainText("Tool-reported HTTP 204");
    await expect(entry).not.toContainText("HTTP 200");
    const pathNode = card.locator(".reader-input-value code.api-path");
    await expect(pathNode).toHaveText("/me/messages");
    assert.equal(await pathNode.evaluate(n => n.closest("button,a") === null), true);
    assert.equal(await pathNode.evaluate(node => {
        const selection = getSelection(), range = document.createRange();
        range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
    }), "/me/messages");
    assert.deepEqual(createRecordedResults().summarize(buildRequestActivity([record])["reported-api"]),
        { count: 1, success: 1, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 });
});

test("multi-call and batched returned results preserve status, service and exact path associations", { timeout: 30000 }, async t => {
    const record = source("batch");
    const first = record.toolCalls[0];
    first.requestArgs.entityUrls = ["/me/messages?Case=A", "/me/calendar/events?Case=B"];
    first.reportedOutcome = "partial";
    first.apiResults = [{ ignored: true }, { index: 99, path: "/me/messages?Case=A", statusCode: 200 },
        { index: 99, path: "/me/calendar/events?Case=B", statusCode: 429, errorCode: "Synthetic_Error" }, { index: 0 }];
    const second = { ...structuredClone(first), tool: "workiq-call_function", toolCallId: "second-call", startEventId: "second-start",
        reportedOutcome: "succeeded", requestedApiPath: "/me/drive/root/children?Case=C", requestArgs: {},
        apiResults: [{ index: 0, path: "/me/drive/root/children?Case=Returned", statusCode: 201 }] };
    record.toolCalls.push(second);
    const { page, url } = await setup(t, [record]);
    const snapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.goto(url + "#request?request=batch"); await ready(page);
    const response = await snapshot;
    assert.equal(response.status(), 200, await response.text());
    const full = (await response.json()).requestActivity;
    assert.deepEqual(full.tool.map(row => row.outcome).sort(), ["partial", "success"]);
    assert.deepEqual(full["reported-api"].map(row => row.outcome).sort(), ["failure", "success", "success", "unknown"]);
    const firstCard = page.locator(`[data-tool-call-id="${first.toolCallId}"]`), secondCard = page.locator('[data-tool-call-id="second-call"]');
    for (const call of [firstCard, secondCard]) {
        const toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        const detail = call.locator(".reader-returned-facts:not([open]) > summary");
        if (await detail.count()) await detail.click();
    }
    await expect(firstCard.locator(".reader-input-value code.api-path")).toHaveText(first.requestArgs.entityUrls);
    const entries = firstCard.locator(".api-result-entry");
    assert.equal(await entries.count(), 3);
    assert.equal(await entries.nth(0).locator(".api-path").textContent(), "/me/messages?Case=A");
    await expect(entries.nth(0).locator(".action-service")).toHaveText("Mail");
    assert.deepEqual(await outcomes(entries.nth(0)), { success: 1 });
    assert.equal(await entries.nth(1).locator(".api-path").textContent(), "/me/calendar/events?Case=B");
    await expect(entries.nth(1).locator(".action-service")).toHaveText("Calendar");
    assert.deepEqual(await outcomes(entries.nth(1)), { failure: 1 });
    assert.equal(await entries.nth(2).locator(".api-path").count(), 0);
    assert.match(await entries.nth(2).innerText(), /No path returned for this batch entry/);
    assert.deepEqual(await outcomes(entries.nth(2)), { unknown: 1 });
    assert.equal(await secondCard.locator(".api-result-entry .api-path").textContent(), "/me/drive/root/children?Case=Returned");
    assert.equal(await secondCard.locator(".api-result-entry .action-service").textContent(), "Files");
    assert.doesNotMatch(await firstCard.innerText(), /Case=Returned/);
    assert.doesNotMatch(await secondCard.innerText(), /Case=A|Case=B/);
});

test("absent paths, unknown completion, API absence and inapplicable tool evidence stay distinct", { timeout: 30000 }, async t => {
    const missing = source("missing");
    missing.toolCalls[0].toolSucceeded = null;
    missing.toolCalls[0].reportedOutcome = "unknown";
    missing.toolCalls[0].apiResults = [];
    missing.toolCalls[0].requestedApiPath = null;
    missing.toolCalls[0].requestArgs = {};
    const code = source("code");
    code.toolCalls = [];
    code.graphActivities = [{
        activityId: "code-reference", sourceSessionId: code.sourceSessionId, scenarioId: code.scenarioId,
        toolCallId: "shell", startEventId: "shell-start", startedAt: "2026-09-30T12:00:00Z", tool: "shell",
        method: "GET", evidenceLevel: "code-reference", endpoint: { path: "/me/messages?Keep=Case", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", httpStatus: null, statusBasis: "none",
        requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }];
    const { page, url } = await setup(t, [missing, code]);
    await page.goto(url + "#request?request=missing"); await ready(page);
    const row = page.locator(`[data-tool-call-id="${missing.toolCalls[0].toolCallId}"]`);
    await expect(row.locator(".reader-call-summary")).toContainText(/no recorded result/i);
    await expect(row.locator(".api-result-entry,code.api-path")).toHaveCount(0);
    await page.goto(url + "#request?request=code"); await ready(page);
    const reference = page.locator("#requestContent .reader-call-row");
    await expect(reference).toHaveCount(1);
    await expect(reference).toContainText("Execution not observed");
    const toggle = reference.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(reference).toContainText("/me/messages?Keep=Case");
    await expect(reference).not.toContainText(/Tool completed|HTTP 2xx/);
});

test("matching result navigation keeps exact paths, selected scope and native focus", { timeout: 30000 }, async t => {
    const record = source("matching", "/me/messages/{Message-ID}?Case=%2F&x=<tag>");
    record.toolCalls[0].toolSucceeded = false;
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 403 }];
    const { page, url } = await setup(t, [record]);
    await page.goto(url + "#activity?session=test-session&result=failure"); await ready(page);
    const link = page.locator("#activityList").getByRole("link", { name: /Returned entry 1.*HTTP 403/ });
    await link.press("Enter"); await ready(page);
    const call = page.locator(`[data-tool-call-id="${record.toolCalls[0].toolCallId}"]`);
    await expect(call.locator(".api-result-entry:focus")).toContainText("Tool-reported HTTP 403");
    await expect(call.locator(".api-result-entry code.api-path")).toHaveText(record.toolCalls[0].requestArgs.entityUrls);
    await expect(call.locator("tag")).toHaveCount(0);
    await page.goBack(); await expect(link).toBeFocused();
    assert.doesNotMatch(page.url(), /[?&]result=/);
    await expect(page.locator("#activityList article")).toHaveAttribute("data-view-key", "request:matching");
});

test("legacy aliases use the canonical call's exact paths, including start-event identities", { timeout: 30000 }, async t => {
    const current = source("canonical", "/me/messages?Source=Current");
    delete current.toolCalls[0].toolCallId;
    current.toolCalls[0].apiResults = [{ index: 0, statusCode: 204, path: "/me/messages?Source=Returned" }];
    const legacy = structuredClone(current);
    legacy.scenarioId = "legacy-alias";
    legacy.isLegacy = true;
    legacy.toolCalls[0].requestedApiPath = "/me/calendar?Source=Older";
    legacy.toolCalls[0].requestArgs.entityUrls = ["/me/calendar?Source=Older"];
    legacy.toolCalls[0].apiResults[0].path = "/me/calendar?Source=OlderResult";
    const { page, url } = await setup(t, [legacy, current]);
    const snapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.goto(url + "#request?request=legacy-alias"); await ready(page);
    const response = await snapshot;
    assert.equal(response.status(), 200, await response.text());
    const { requestActivity } = await response.json();
    assert.deepEqual(requestActivity.tool.map(row => row.scenarioId), ["canonical"]);
    assert.deepEqual(requestActivity["reported-api"].map(row => row.parentCallId), [requestActivity.tool[0].id]);
    const calls = page.locator("#requestContent .reader-call-row");
    await expect(calls).toHaveCount(1);
    const toggle = calls.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(calls.locator(".reader-input-value code.api-path")).toHaveText("/me/messages?Source=Current");
    await expect(calls.locator(".api-result-entry code.api-path")).toHaveText("/me/messages?Source=Returned");
    await expect(calls).not.toContainText("Source=Older");
});

test("returned-result pages retain every canonical entry without assigning the first target to the rest", { timeout: 30000 }, async t => {
    const record = source("many-results");
    record.toolCalls[0].apiResults = Array.from({ length: 8 }, (_, index) => ({
        index, path: `/me/messages/{Result-${index}}?Exact=%2F`,
        statusCode: index % 3 === 0 ? 204 : index % 3 === 1 ? 429 : null,
    }));
    const { page, url } = await setup(t, [record]);
    await page.goto(url + "#request?request=many-results"); await ready(page);
    const call = page.locator(`[data-tool-call-id="${record.toolCalls[0].toolCallId}"]`);
    const toggle = call.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    // Batches containing an error expose every entry together, including a later error.
    const entries = call.locator(".api-result-entry");
    await expect(entries).toHaveCount(8);
    await expect(entries.locator("code.api-path")).toHaveText(record.toolCalls[0].apiResults.map(result => result.path));
    assert.deepEqual(await entries.locator(".recorded-result").evaluateAll(nodes => nodes.map(n => n.dataset.outcome)),
        ["success", "failure", "unknown", "success", "failure", "unknown", "success", "failure"]);
    await expect(call.getByRole("button", { name: "Next returned results" })).toHaveCount(0);
});

test("successful returned entries can be paged without losing their unique paths", async t => {
    const record = source("paged-entries");
    record.toolCalls[0].apiResults = Array.from({ length: 8 }, (_, index) => ({
        index, path: `/me/messages/{Result-${index}}?Exact=%2F`, statusCode: 204,
    }));
    const { page, url } = await setup(t, [record]);
    await page.goto(url); await ready(page);
    await page.locator("#activityList .request-card-open").click();
    const summary = page.locator(`[data-tool-call-id="${record.toolCalls[0].toolCallId}"]`);
    const toggle = summary.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(summary.locator(".api-result-entry code.api-path")).toHaveText(record.toolCalls[0].apiResults.slice(0, 6).map(result => result.path));
    const next = summary.getByRole("button", { name: "Next returned results", exact: true });
    await next.focus(); await page.keyboard.press("Enter");
    assert.deepEqual(await summary.locator(".api-result-entry code.api-path").allTextContents(), record.toolCalls[0].apiResults.slice(6).map(result => result.path));
    await summary.getByRole("button", { name: "Previous returned results", exact: true }).click();
    await expect(summary.locator(".api-result-entry code.api-path")).toHaveText(record.toolCalls[0].apiResults.slice(0, 6).map(result => result.path));
});
