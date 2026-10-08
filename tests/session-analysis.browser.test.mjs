import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

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

test("identified session -> exactly two failed canonical actions -> full mixed request -> same session", { timeout: 60000 }, async t => {
    const { page, posts } = await setup(t);
    const group = page.locator('[data-session-id="session-a"]');
    assert.equal(await group.locator(".session-label").innerText(), "Copilot chat name");
    assert.match(await page.locator("#pageIntro").innerText(), /GitHub Copilot chats/);
    const failure = group.getByRole("link", { name: /View 2 Work IQ tool calls needing attention/ });
    assert.equal(await failure.count(), 1);
    assert.equal(await group.locator(".session-toggle").getAttribute("aria-expanded"), "false");
    await failure.focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.match(page.url(), /session=session-a/);
    assert.match(page.url(), /result=failure/);
    assert.equal(await page.locator("#pageTitle").innerText(), "Moments access recovery");
    assert.match(await page.locator("#sessionAnalysis").innerText(), /request groups with 19 Work IQ tool calls/);
    assert.equal(await page.locator(".matched-action").count(), 2);
    assert.ok((await page.locator(".matched-action").first().boundingBox()).y < 900, "Failure navigation reveals the matching action without manual hunting");
    assert.match(await page.locator(".matched-action").allTextContents().then(x => x.join(" ")), /AccessDenied/);
    assert.match(await page.locator(".matched-action").allTextContents().then(x => x.join(" ")), /Failure cause unavailable in retained evidence/);
    assert.equal(await page.locator('[data-session-id="session-b"]').count(), 0);
    assert.equal(await page.locator(".session-toggle a,.session-toggle button").count(), 0);
    await page.locator(".matched-action").filter({ hasText: "AccessDenied" }).getByRole("link", { name: "View interaction" }).click(); await ready(page);
    assert.equal(await page.locator(".journey-item").count(), 2);
    assert.equal(await page.locator("#breadcrumbs").getByRole("link", { name: "GitHub Copilot chat: Moments access recovery", exact: true }).count(), 1);
    assert.match(await page.locator(".request-intro").innerText(), /GitHub Copilot chat: Moments access recovery/);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 2);
    await page.reload(); await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 2);
    assert.ok((await page.locator(".matched-action").first().boundingBox()).y < 900, "Deep-link reload reveals the matching action");
    assert.ok(!posts.some(p => ["/api/export", "/api/record", "/api/move", "/api/collection/now"].includes(p)));
});

test("choosing a session resets incompatible filters and deliberately selects its entire canonical report", { timeout: 60000 }, async t => {
    const { page, runtime, context, posts } = await setup(t);
    const before = await loadBoardState(context);
    await page.goto(runtime.url + "#activity?result=failure&from=2026-09-30&to=2026-09-30&service=Calendar&project=test-project"); await ready(page);
    await page.locator("#activitySearch").fill("Synthetic request 13");
    await page.locator('[data-session-id="session-a"] .session-drill').click(); await ready(page);
    const params = new URLSearchParams(page.url().split("?")[1]);
    assert.equal(params.get("session"), "session-a");
    for (const key of ["result", "project", "endpoint"]) assert.equal(params.has(key), false);
    assert.equal(params.get("service"), "Calendar");
    assert.equal(params.get("from"), "2026-09-30");
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
    await page.locator("#createSessionReport").click(); await ready(page);
    assert.equal(await page.locator('[name=reportScope][value=selected]').isChecked(), true);
    assert.match(await page.locator("#previewSelectionSummary").innerText(), /17 request groups included/);
    assert.match(await page.locator("#scopeExplanation").textContent(), /Complete eligible request groups across all retained dates/);
    await page.locator("#reportRequests>summary").click();
    const ids = new Set();
    do {
        for (const key of await page.locator(".report-entry").evaluateAll(nodes => nodes.map(n => n.dataset.viewKey))) ids.add(key);
        const next = page.getByRole("button", { name: "Next report requests", exact: true });
        if (await next.isDisabled()) break;
        await next.click();
    } while (true);
    assert.equal(ids.size, 17);
    assert.equal([...ids].some(id => /other-session|legacy-alias/.test(id)), false);
    await page.getByRole("button", { name: "Back to Copilot chat", exact: true }).click(); await ready(page);
    await page.locator("#pageHeadingActions").getByRole("link", { name: "Back to Copilot chats", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic request 13");
    assert.match(page.url(), /result=failure/);
    await page.goto(runtime.url + "#activity?session=session-b"); await ready(page);
    await page.locator("#createSessionReport").click(); await ready(page);
    assert.match(await page.locator("#previewSelectionSummary").innerText(), /1 request group included/);
    assert.match(await page.locator(".report-entry-context").innerText(), /Moments access recovery/);
    await page.locator(".report-start [data-clear-selection]").click();
    assert.equal(await page.locator("#previewSelectionSummary").innerText(), "No requests selected");
    assert.equal(await page.locator(".report-entry-context").isVisible(), false);
    const after = await loadBoardState(context);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.exports, before.exports);
    assert.ok(!posts.some(p => ["/api/preview", "/api/export", "/api/record", "/api/move"].includes(p)));
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
    await page.locator('[data-session-id="missing-session"] .session-drill').click(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /Saved history is unavailable/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
    assert.equal(await page.locator("#sessionAnalysis").getByRole("link", { name: "Review collection status", exact: true }).count(), 1);
    await page.goto(runtime.url + "#activity?session=code-session"); await ready(page);
    await page.getByRole("link", { name: "Inspect Graph code references", exact: true }).click(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /Execution not observed/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
    await page.goto(runtime.url + "#activity?session=session-a"); await ready(page);
    assert.match(await page.locator("#pageProject").innerText(), /Copilot folder project/);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /Partial history/);
    roster[0].eligible = false; roster[0].disposition = "archived";
    await replaceEvidence(context, () => ({ records: [...source, code], importCoverage: { dynamic: {}, counts: {}, roster } }));
    await page.reload(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /no longer in Current activity/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
    await page.getByRole("link", { name: "Inspect preserved activity", exact: true }).click(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /request groups with 19 Work IQ tool calls/);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        delete data.sessionAnalysis;
        await route.fulfill({ response, json: data });
    });
    await page.reload(); await ready(page);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /result counts unavailable/);
    assert.equal(await page.locator("#sessionAnalysis a.result-link").count(), 0);
});

test("keyboard/touch targets, themes and polling retain the selected failed action", { timeout: 60000 }, async t => {
    const { page, source, context } = await setup(t);
    await page.locator('[data-session-id="session-a"]').getByRole("link", { name: /View 2 Work IQ tool calls needing attention/ }).click(); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 900 }); await chooseTheme(page, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator(".result-link:visible").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 44)), true);
        assert.equal(await page.locator(".matched-action").evaluateAll(nodes => nodes.every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 16)), true);
        if (process.env.WORKIQ_SESSION_PROOFS) {
            await mkdir(process.env.WORKIQ_SESSION_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WORKIQ_SESSION_PROOFS, `session-analysis-${theme}-${width}.png`), fullPage: true });
        }
    }
    const focused = page.locator(".matched-action .text-link").first();
    await focused.focus();
    const href = await focused.getAttribute("href");
    const incoming = fixture("new-request");
    incoming.sourceSessionId = "session-b";
    await replaceEvidence(context, () => ({ records: [...source, incoming], importCoverage: { counts: {}, roster: [] } }));
    await page.waitForResponse(r => r.url().endsWith("/api/snapshot"), { timeout: 15000 });
    await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("href")), href);
    assert.match(page.url(), /session=session-a/);
});
