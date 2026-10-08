import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";

test("history issues are scoped, bounded and stable during polling in both themes and touch layouts", { timeout: 90000 }, async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce", hasTouch: true });
    const failures = [], mutations = [], model = createCollectionStatus();
    page.on("pageerror", e => failures.push(e.message));
    page.on("request", r => { if (/\/api\/(?:export|preview|record|privacy-review|collection\/(?:now|enabled|configure))$/.test(r.url())) mutations.push(r.url()); });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const sources = Array.from({ length: 15 }, (_, i) => ({ sessionId: `source-${i}`, name: `Synthetic unavailable session ${i + 1}`,
        project: i % 2 ? null : "Synthetic project", projectId: i % 2 ? null : "synthetic-project", eligible: true }));
    sources.push({ sessionId: "limited", name: "Synthetic limited session", eligible: true });
    let cursors = sources.map(r => ({ sessionId: r.sessionId, lastAttemptAt: "2026-10-05T01:00:00Z",
        ...(r.sessionId === "limited" ? { scanned: true, cursor: { droppedBytes: 10, oversizedLines: 2 }, diagnostics: { contextEvictions: 3 } }
            : { error: "PRIVATE_ERROR token=private <img src=x onerror=alert(1)>", errorCode: "ENOENT" }) }));
    let detailedReads = 0;
    const status = () => {
        const { summary, issues } = model.coverage(sources, cursors, ["source-0"]);
        return { state: "collecting-on-interval", revision: before.revision, lastCheckedAt: "2026-10-05T01:00:00Z", lastNewDataAt: "2026-10-04T23:00:00Z",
            connected: true, config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 },
            discovery: { counts: { sessions: 20, eligible: 16, dispositions: { eligible: 16, archived: 4 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
            cadence: { pollSeconds: 5 }, metrics: {}, historyCoverage: summary, historyIssues: issues, sourceErrors: summary.unavailable };
    };
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        const { historyIssues, ...summary } = status();
        await route.fulfill({ response, json: { ...payload, collection: summary } });
    });
    await page.route("**/api/collection/status", async route => {
        const detail = route.request().postDataJSON().details === true;
        if (detail) detailedReads++;
        const { historyIssues, ...summary } = status();
        await route.fulfill({ json: detail ? { ...summary, historyIssues } : summary });
    });
    await page.goto(runtime.url);
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    assert.equal(await page.locator("#collectionStatus").textContent(), "Collection active");
    assert.match(await page.locator("#collectionIssueLabel").textContent(), /16 Copilot chats affected/);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false);
    assert.equal(await page.locator("#collectionStrip").isVisible(), false);
    assert.equal(await page.locator("#collectionSetup").getAttribute("open"), null);
    assert.equal(detailedReads, 0, "No personal issue inventory requested until opened");
    const chartBefore = await page.locator("#chart").innerHTML();
    await navigateMain(page, "collection-status");
    await page.locator(".history-reason>summary").first().waitFor();
    assert.equal(await page.locator(".history-issue").count(), 0, "Reasons start closed; no extra outer Issues disclosure");
    await page.locator(".history-reason>summary").first().click();
    await page.locator(".history-issue").first().waitFor();
    assert.equal(await page.locator(".history-issue").count(), 6);
    assert.match(await page.locator("#collectionIssuesBody").innerText(), /not failed Work IQ or Graph requests/);
    const first = page.locator(".history-issue>summary").first();
    await first.focus(); await page.keyboard.press("Space");
    assert.match(await page.locator(".history-issue-detail").innerText(), /Previously collected evidence.*kept/);
    assert.match(await page.locator(".history-issue-detail").innerText(), /Oct 4, 2026.*GMT-7/);
    assert.doesNotMatch(await page.locator("#collectionIssuesBody").innerText(), /PRIVATE_ERROR|token=private|onerror|C:\\synthetic/);
    await first.evaluate(node => { window.issueFocusNode = node; });
    const scrollBefore = await page.evaluate(() => scrollY);
    const initialReads = detailedReads;
    cursors = cursors.map(r => ({ ...r, lastAttemptAt: "2026-10-05T01:01:00Z" }));
    await page.waitForFunction(() => document.querySelector("[data-history-attempt]").textContent.includes("6:01:00"));
    assert.ok(detailedReads > initialReads);
    assert.equal(await page.evaluate(() => document.activeElement === window.issueFocusNode && window.issueFocusNode.isConnected), true);
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - scrollBefore) < 2);
    assert.equal(await page.locator("#chart").innerHTML(), chartBefore);
    sources.unshift({ sessionId: "new-first", name: "New synthetic source", eligible: true });
    cursors.unshift({ sessionId: "new-first", error: "missing", errorCode: "ENOENT", lastAttemptAt: "2026-10-05T01:01:00Z" });
    await page.waitForFunction(() => document.querySelector("#collectionIssueLabel").textContent.includes("17 Copilot chats"));
    assert.equal(await first.evaluate(node => node === document.activeElement), true, "New issues append without moving an existing focused source");
    assert.match(await page.locator("#collectionIssueCounts").innerText(), /16 unavailable.*1 with limited history/);
    await page.getByRole("button", { name: "Next affected Copilot chats", exact: true }).click();
    assert.match(await page.locator("#collectionIssueGroups").innerText(), /7-12 of 16 affected Copilot chats/);
    await page.getByRole("button", { name: "Next affected Copilot chats", exact: true }).click();
    assert.match(await page.locator("#collectionIssueGroups").innerText(), /13-16 of 16 affected Copilot chats/);
    assert.equal(await page.locator(".history-issue").count(), 4);
    await page.locator(".history-reason>summary").last().click();
    await page.locator(".history-reason").last().locator(".history-issue>summary").click();
    assert.match(await page.locator(".history-reason").last().innerText(), /No evidence has been collected/);
    assert.match(await page.locator(".history-reason").last().innerText(), /limited working memory/);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            for (const selector of [".history-reason>summary", "#collectNow", "#pauseCollection", "#collectionSetup>summary", ".history-issue>summary"]) {
                for (const box of await page.locator(selector).evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).map(n => ({ height: n.getBoundingClientRect().height })))) assert.ok(box.height >= 44, `${selector} touch target`);
            }
        }
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await navigateMain(page, "settings");
    assert.equal(await page.locator("#collectionIssuesBody").isVisible(), false);
    await page.goBack();
    await page.locator(".history-reason").last().locator(".history-issue-detail").waitFor();
    assert.match(await page.locator("#collectionIssueGroups").innerText(), /13-16 of 16 affected Copilot chats/);
    cursors = cursors.map(r => ({ ...r, error: null, errorCode: null, scanned: true, cursor: {}, diagnostics: {} }));
    await page.waitForFunction(() => document.querySelector("#collectionIssueLabel").textContent === "No current history issues reported");
    assert.equal(await page.locator("#issueSearch").isVisible(), false);
    assert.equal(await page.locator("#collectionIssueCounts").isVisible(), false);
    assert.equal(await page.locator("#collectionIssueGroups").isVisible(), false);
    assert.equal(await page.locator("#chart").innerHTML(), chartBefore);
    const after = await loadBoardState(context);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.exports, before.exports);
    assert.deepEqual(mutations, []);
    assert.deepEqual(failures, []);
});
