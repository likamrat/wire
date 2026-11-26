import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { fixture, privateFixture, openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption } from "../support/helpers.mjs";
import { replaceEvidence } from "../../lib/store.mjs";

function records() {
    const items = Array.from({ length: 17 }, (_, i) => {
        const row = fixture("session-request-" + i);
        row.sourceSessionId = "session-a";
        row.sourceSessionName = "Moments access recovery";
        row.project = "One project";
        row.userPrompt.text = "Synthetic request " + i;
        row.userPrompt.sourceTimestamp = new Date(Date.UTC(2026, 8, 30, 12, i)).toISOString();
        row.toolCalls[0].startedAt = row.userPrompt.sourceTimestamp;
        if ([0, 13].includes(i)) {
            row.toolCalls[0].toolSucceeded = false;
            row.toolCalls[0].reportedOutcome = "failed";
            row.toolCalls[0].apiResults = i === 0 ? [{ index: 0, statusCode: 403, errorCode: "AccessDenied" }] : [];
            row.toolCalls.push({ ...structuredClone(row.toolCalls[0]), toolCallId: "worked-" + i, startEventId: "worked-start-" + i, toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [] });
        }
        if (i === 1) { row.toolCalls[0].toolSucceeded = null; row.toolCalls[0].reportedOutcome = "unknown"; row.toolCalls[0].apiResults = []; }
        return row;
    });
    const other = fixture("other-session-request");
    other.sourceSessionId = "session-b";
    other.sourceSessionName = items[0].sourceSessionName;
    other.projectId = null; other.project = null;
    other.toolCalls[0].toolSucceeded = false;
    other.toolCalls[0].reportedOutcome = "failed";
    return [...items, other, { ...structuredClone(items[0]), scenarioId: "legacy-alias", isLegacy: true }];
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t) {
    const source = records(), { context } = await privateFixture(t, source);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Los_Angeles" });
    const errors = [], posts = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (r.method() === "POST") posts.push(new URL(r.url()).pathname); });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    await page.goto(runtime.url + "#activity"); await ready(page);
    assert.equal(await page.locator("#collectionForm").isVisible(), false);
    return { page, context, runtime, source, posts };
}

test("same-name chats stay separate through an exact failure filter, mixed reader and Back", async t => {
    const { page, posts } = await setup(t);
    await selectActivityOption(page, "chatFilter", "session-a"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", ["failure"]); await ready(page);
    await closeAnalyzeFilters(page);
    const list = page.locator("#activityList");
    await expect(page.locator("#activityListSummary")).toHaveText("2 interactions · 2 matching tool calls");
    assert.deepEqual((await list.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey))).sort(),
        ["request:session-request-0", "request:session-request-13"]);
    const open = list.locator('[data-view-key="request:session-request-0"] .request-card-open').first();
    await open.focus(); await open.press("Enter");
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
    await expect(page.locator("#requestContent")).toContainText("AccessDenied");
    await page.goBack();
    await expect(open).toBeFocused();
    await expect(page.locator("#chatFilter")).toHaveValue("session-a");
    await expect(page.locator("#activityListSummary")).toHaveText("2 interactions · 2 matching tool calls");
    assert.ok(!posts.some(p => ["/api/export", "/api/record", "/api/move", "/api/collection/now"].includes(p)));
});
test("scope, history gaps, code-only and unavailable summaries never manufacture failures", { timeout: 60000 }, async t => {
    const { page, runtime, context, source } = await setup(t);
    const code = { ...fixture("code-only"), sourceSessionId: "code-session", sourceSessionName: "Code-only notes", toolCalls: [], graphActivities: [{
        activityId: "code-site", toolCallId: "shell-code", startEventId: "code-start", sourceSessionId: "code-session", scenarioId: "code-only",
        startedAt: "2026-09-30T12:00:00Z", tool: "shell", method: "GET", evidenceLevel: "code-reference",
        endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", httpStatus: null, statusBasis: "none", requestCount: null, countUnit: "recorded-request-site",
        confidence: "high", synthetic: false, sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }] };
    const roster = [
        { sessionId: "session-a", name: "Moments access recovery", projectId: "test-project", project: "One project", projectType: "folder", eligible: true, scanned: true, cursor: { droppedBytes: 100 }, diagnostics: {} },
        { sessionId: "session-b", name: "Moments access recovery", eligible: true, scanned: true },
        { sessionId: "missing-session", name: "Unreadable history", eligible: true, error: "Local error", errorCode: "ENOENT" },
        { sessionId: "code-session", name: "Code-only notes", eligible: true, scanned: true },
    ];
    await replaceEvidence(context, () => ({ records: [...source, code], importCoverage: { dynamic: {}, counts: {}, roster } }));
    await page.goto(runtime.url + "#activity"); await ready(page);
    await page.goto(runtime.url + "#analyze?session=missing-session"); await ready(page);
    await openAnalyzeFilters(page);
    await expect(page.locator(".session-coverage")).toHaveText(/Saved history is unavailable/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
    assert.equal(await page.locator("#sessionAnalysis").getByRole("link", { name: "Review collection status", exact: true }).count(), 1);
    await page.goto(runtime.url + "#activity?session=code-session"); await ready(page);
    await openAnalyzeFilters(page);
    await page.getByRole("link", { name: "Inspect Graph code references", exact: true }).click(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /Execution not observed/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
    await page.goto(runtime.url + "#activity?session=session-a"); await ready(page);
    await openAnalyzeFilters(page);
    await expect(page.locator(".session-coverage")).toHaveText(/Partial history/);
    await closeAnalyzeFilters(page);
    roster[0].eligible = false; roster[0].disposition = "archived";
    await replaceEvidence(context, () => ({ records: [...source, code], importCoverage: { dynamic: {}, counts: {}, roster } }));
    await page.goto(runtime.url + "#analyze?session=session-a"); await ready(page);
    await openAnalyzeFilters(page);
    await expect(page.locator(".session-coverage")).toHaveText(/no longer in Current activity/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
    await page.getByRole("link", { name: "Inspect preserved activity", exact: true }).click(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /request groups with 19 Work IQ tool calls/);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        delete data.sessionAnalysis;
        await route.fulfill({ response, json: data });
    });
    await page.goto(runtime.url + "#analyze?session=session-a&scope=all"); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /result counts are unavailable/i);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
});
