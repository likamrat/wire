import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption } from "./helpers.mjs";

const original = "Original session question.\n" + "Retain this session wording exactly. ".repeat(12);
const title = "Historical session title";
async function setup(t, { name = title, includeUnlinked = false } = {}) {
    const records = ["one", "two", "unnamed"].map(id => {
        const row = fixture(id);
        row.sourceSessionId = `source-${id}`;
        row.sourceSessionName = id === "unnamed" ? null : name;
        row.userPrompt.text = original;
        row.userPrompt.sourceTimestamp = row.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
        if (id !== "one") { row.projectId = null; row.project = null; }
        return row;
    });
    records[0].toolCalls.push({
        ...structuredClone(records[0].toolCalls[0]), toolCallId: "failed-call", startEventId: "failed-start",
        toolSucceeded: false, reportedOutcome: "failed", apiResults: [{ index: 0, statusCode: 403, errorCode: "Original session error" }],
    });
    if (includeUnlinked) records.push({ ...fixture("unlinked"), sourceSessionId: null, sourceSessionName: null, projectId: null, project: null });
    let cleanup;
    const { context } = await privateFixture({ after: callback => { cleanup = callback; } }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], denied = [], origin = new URL(runtime.url).origin;
    const reads = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
        "/api/evaluation/automatic/summary", "/api/preview", "/api/cancel-preview"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && (request.method() === "GET" || request.method() === "POST" && reads.has(url.pathname))) return route.continue();
        denied.push(`${request.method()} ${url.pathname}`);
        return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Clipboard reads prohibited in terminology test."); },
        writeText() { throw Error("Clipboard writes prohibited in terminology test."); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(denied, []); assert.deepEqual(errors, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { await cleanup(); }
    });
    return { page, url: runtime.url };
}

test("chat scope preserves recorded text through outcome drilldown, report preview and history gaps", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t);
    const coverage = createCollectionStatus().coverage([{ sessionId: "missing", name: title, eligible: true }],
        [{ sessionId: "missing", errorCode: "ENOENT", error: "Original session error", lastAttemptAt: "2026-10-05T01:00:00Z" }]);
    await page.route(new URL("/api/collection/status", url).href, route => {
        assert.equal(route.request().method(), "POST");
        return route.fulfill({ json: { revision: 1, connected: true, state: "collecting-on-interval", lastCheckedAt: "2026-10-05T01:00:00Z",
            config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 },
            historyCoverage: coverage.summary, historyIssues: coverage.issues, discovery: { counts: { sessions: 3, dispositions: { eligible: 1, archived: 2 } } } } });
    });
    await page.goto(url);
    await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    await expect(page.locator("#activityCount")).toHaveText("4");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-30");
    await page.locator("#toFilter").fill("2026-09-30");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click();
    await selectActivityOption(page, "chatFilter", "source-one");
    const region = page.getByRole("region", { name: "Copilot chat analysis", exact: true });
    await expect(region).toContainText("1 request group with 2 Work IQ tool calls");
    for (const [outcome, description] of [["success", "with recorded completion"], ["failure", "needing attention"]]) {
        const link = region.getByRole("link", { name: `View 1 Work IQ tool call ${description} in chat ${title}. Current date, service and request scope.`, exact: true });
        await link.hover(); await expect(page.getByRole("tooltip")).toContainText("this Copilot chat and scope");
        await page.keyboard.press("Escape"); await openAnalyzeFilters(page);
        await link.click();
        await expect(page.locator("#chatFilter")).toHaveValue("source-one");
        await expect(page.locator("#outcomeFilter")).toHaveValues([outcome]);
        await expect(page.locator("#activityCount")).toHaveText("1");
    }
    await closeAnalyzeFilters(page);
    const card = page.locator("#activityList .request-card-open");
    await expect(card).toHaveCount(1);
    await card.press("Enter");
    const reader = page.locator("#contextSidebar");
    await expect(reader).toBeVisible();
    assert.equal(await reader.locator('[aria-label="Exact recorded prompt text"]').textContent(), original);
    await expect(reader).toContainText("Tool-reported HTTP 403: Original session error");
    await page.goBack();
    await expect(reader).toBeHidden(); await expect(card).toBeFocused();
    await openAnalyzeFilters(page);
    await page.getByRole("button", { name: "Create report for this chat", exact: true }).click();
    const reports = page.getByRole("region", { name: "Reports", exact: true });
    await expect(reports.locator(".report-entry-context")).toContainText(title);
    await expect(reports.getByRole("button", { name: "Activity source: Selected interactions" })).toBeVisible();
    await expect(reports.getByRole("radio", { name: /^Mask detected details/ })).toBeChecked();
    await expect(reports.getByRole("radio", { name: "Keep chat details" })).not.toBeChecked();
    const response = page.waitForResponse(r => r.url() === new URL("/api/preview", url).href);
    await reports.getByRole("button", { name: "Prepare preview", exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200);
    const preview = await result.json();
    assert.equal(preview.promptMode, "masked");
    assert.equal(preview.snapshot.records.length, 1);
    assert.equal(preview.snapshot.records[0].toolCalls.length, 2);
    assert.equal(preview.privacy.reviewerConfirmed, false);
    await reports.getByRole("link", { name: "Back to Analyze", exact: true }).click();
    await expect(page.locator("#chatFilter")).toHaveValue("source-one");
    await navigateMain(page, "settings"); await navigateSettings(page, "connection"); await navigateMain(page, "collection-status");
    await page.locator(".history-reason > summary").click();
    await page.locator(".history-issue > summary").click();
    await expect(page.locator("#collectionIssueLabel")).toHaveText("1 chat with history gaps");
    await expect(page.locator("#collectionIssueCounts")).toContainText("1 unavailable");
    await expect(page.locator(".history-issue-detail")).toContainText("No evidence has been collected for this Copilot chat");
    await expect(page.locator(".history-issue-identity")).toContainText(title);
    await expect(page.locator(".history-issue-identity")).toContainText("Copilot chat without a project");
    await expect(page.locator("#sourceEditor")).toBeHidden();
});

test("keyboard selection distinguishes duplicate chat names at narrow and enlarged widths", { timeout: 60000 }, async t => {
    const name = `${title} ${"longunbrokentoken".repeat(10)} \u65e5\u672c\u8a9e \u2014 \u00e9vidence`;
    const { page, url } = await setup(t, { name });
    await page.goto(url);
    const chat = page.getByRole("combobox", { name: "Chat", exact: true });
    const list = page.getByRole("listbox", { name: "Chat", exact: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const [width, size] of [[1200, 100], [375, 200]]) {
            await page.setViewportSize({ width, height: 950 });
            await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
            await openAnalyzeFilters(page);
            if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFilters > summary").click();
            await chat.scrollIntoViewIfNeeded();
            await chat.press("Enter");
            for (const suffix of ["urce-one", "urce-two"]) {
                const option = list.getByRole("option", { name: `${name} (Chat ...${suffix})`, exact: true });
                await expect(option).toBeVisible();
                const clipped = await option.locator(".select-option-label").evaluate(node =>
                    node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
                assert.equal(clipped, false, `${width}/${size}%/${theme}: full chat name and suffix must wrap`);
            }
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await chat.press("Escape");
            await expect(list).toBeHidden(); await expect(chat).toBeFocused();
            await expect(page.locator("#chatFilter")).toHaveValue("all");
            await closeAnalyzeFilters(page);
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
    await openAnalyzeFilters(page);
    await chat.scrollIntoViewIfNeeded(); await chat.press("Enter");
    await chat.press("ArrowDown"); await chat.press("ArrowDown");
    await chat.press("Enter");
    await expect(page.locator("#chatFilter")).toHaveValue("source-two");
    await expect(chat).toBeFocused();
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#pageProject")).toContainText(name);
    const card = page.locator("#activityList .request-card-open");
    await card.press("Enter");
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await expect(page.locator('#contextSidebar [data-tool-call-id="test-call-two"]').first()).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(card).toBeFocused();
    await expect(page.locator("#chatFilter")).toHaveValue("source-two");
});

test("an unnamed chat can be selected; an interaction without a chat cannot supply a source link", async t => {
    const { page, url } = await setup(t, { includeUnlinked: true });
    await page.goto(url);
    await selectActivityOption(page, "chatFilter", "source-unnamed");
    await expect(page.getByRole("combobox", { name: "Chat", exact: true })).toContainText("Copilot chat name not recorded (Chat ...-unnamed)");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-10-01");
    await page.locator("#toFilter").fill("2026-10-01");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click();
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(0);
    await page.goto(url + "#request?request=unlinked");
    const reader = page.locator("#contextSidebar");
    await expect(reader).toContainText("Chat identity was not retained; surrounding groups cannot be linked.");
    await reader.getByRole("button", { name: "Source details", exact: true }).click();
    for (const field of ["Chat", "Project"]) {
        const label = reader.getByText(field, { exact: true }).filter({ visible: true }).last();
        await expect(label.locator("..").locator("dd")).toHaveText("Not recorded");
    }
    await expect(reader.getByRole("link", { name: /chat/i })).toHaveCount(0);
});
