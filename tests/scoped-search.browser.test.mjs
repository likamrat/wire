import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { fixture, exportCatalogFor, navigateMain, chooseTheme, selectActivityOption, openSourceEditor } from "./helpers.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_SEARCH_PROOFS;
async function ready(page) { await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false"); }
async function category(page, id) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const anchor = page.locator(`#settingsCategoryNav [data-category=${id}]`);
    if (!await anchor.isVisible()) await page.locator("#settingsCategorySummary").click();
    await anchor.click();
    await expect(page.locator(`[data-settings-section=${id}]`)).toBeVisible();
}
async function setup(t, approved = true) {
    const records = Array.from({ length: 19 }, (_, i) => ({
        ...fixture(`search-request-${i}`), sourceSessionId: `search-chat-${i}`,
        sourceSessionName: i === 18 ? "Zephyr-end <img> chat" : `Synthetic chat ${i}`,
        title: `Request group ${i}`, userPrompt: { ...fixture().userPrompt, text: i === 18 ? "UNIQUE RETAINED final-request" : `Synthetic request text ${i}` },
    }));
    const sessions = records.map(row => ({ sessionId: row.sourceSessionId, name: row.sourceSessionName, projectId: "test-project", project: "Synthetic project", eligible: true }));
    sessions.push({ sessionId: "metadata-only", name: "Metadata-only <svg> chat", eligible: true });
    const exports = Array.from({ length: 15 }, (_, i) => ({
        bundleId: i === 14 ? "Report-Zephyr <img>" : `Report-${i}`, promptMode: i === 14 ? "original" : "masked",
        preparedAt: "2026-10-05T12:00:00Z", preparedAtDisplay: "Oct 5, 2026", formats: [i === 14 ? "markdown" : "html"],
        timeContext: { timeZone: "UTC", locale: "en-US" }, files: {},
    }));
    const coverage = createCollectionStatus().coverage(sessions.slice(0, 19), sessions.slice(0, 19).map(row => ({ sessionId: row.sessionId, errorCode: "ENOENT", error: "Synthetic missing file", lastAttemptAt: "2026-10-05T12:00:00Z" })), []);
    let status = {
        revision: 1, configVersion: 1, state: approved ? "collecting-on-interval" : "not-configured", connected: approved,
        config: approved ? { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", windowDays: 30, pollSeconds: 5 } : null,
        suggestedSource: { appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
        cadence: { pollSeconds: 5 }, metrics: {}, historyCoverage: coverage.summary, historyIssues: coverage.issues,
        discovery: { counts: { sessions: 20, eligible: 19, dispositions: { eligible: 19 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
    };
    const requests = [], failures = [], writes = [];
    const server = createServer(async (req, res) => {
        if (req.url === "/" && req.method === "GET") { res.setHeader("Content-Type", "text/html"); return res.end(renderHtmlShell("a".repeat(64), "search-proof")); }
        if (req.url === "/favicon.ico") return res.writeHead(204).end();
        let body = ""; for await (const part of req) body += part;
        const input = body ? JSON.parse(body) : {};
        requests.push({ url: req.url, input });
        res.setHeader("Content-Type", "application/json");
        const { historyIssues, ...summary } = status;
        if (req.url === "/api/snapshot") return res.end(JSON.stringify({
            revision: 1, scenarios: records, sessions, exports, exportCatalog: exportCatalogFor(records),
            coverage: { notes: ["Synthetic search proof only."] }, collection: summary,
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
        if (req.url === "/api/collection/status") return res.end(JSON.stringify(input.details ? status : summary));
        writes.push(req.url);
        res.writeHead(403).end(JSON.stringify({ error: "No mutations allowed in this search fixture." }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, hasTouch: true, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => failures.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(writes, []); assert.deepEqual(failures, []);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(url + "#settings"); await ready(page);
    return { page, url, requests, status: () => status, setStatus: patch => { status = { ...status, ...patch }; } };
}

test("Settings category links, deep links, native history and reload expose exactly one pane", { timeout: 45000 }, async t => {
    const { page, url } = await setup(t);
    for (const id of ["display", "connection", "collection"]) {
        await category(page, id);
        assert.equal(await page.locator("[data-settings-section]:visible").count(), 1);
        assert.equal(await page.locator(`#settingsCategoryNav [aria-current=page]`).getAttribute("data-category"), id);
        assert.equal(await page.locator("#settingsCategoryNav [role=tab]").count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.closest("[data-settings-section]")?.dataset.settingsSection), id);
        await page.reload(); await ready(page);
        assert.equal(await page.locator("[data-settings-section]:visible").getAttribute("data-settings-section"), id);
    }
    await category(page, "display"); await category(page, "collection");
    await page.goBack(); await expect(page.locator("#displayTitle")).toBeVisible();
    await page.goForward(); await expect(page.locator("#preferencesTitle")).toBeVisible();
    await page.goto(url + "#settings?section=history"); await ready(page);
    assert.match(page.url(), /section=connection&setting=history-window/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "collectionWindow-control");
    await page.goto(url + "#settings?issues=1"); await ready(page);
    await expect(page.locator(".history-reason").first()).toBeVisible();
    assert.match(page.url(), /#collection-status\?setting=issues/);
    assert.equal(await page.locator("#collectionIssuesTitle").evaluate(node => node === document.activeElement), true);
    await page.goto(url + "#settings?section=madeup&setting=unknown"); await ready(page);
    await expect(page.locator("#settingsRouteNotice")).toContainText("Unknown settings category");
    assert.equal(new URL(page.url()).hash, "#settings?section=connection");
    await expect(page.locator("#connectionTitle")).toBeVisible();
});

test("Settings search navigates controls without acting; drafts, query, caret and disabled reasons survive polling", { timeout: 45000 }, async t => {
    const { page, requests } = await setup(t);
    await openSourceEditor(page);
    await page.locator("#sourceSessions").fill("C:\\SYNTHETIC_DIRTY\\session-state");
    await category(page, "collection");
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#settingsSearch").fill("city");
    await expect(page.locator("#settingsSearchCount")).toContainText("1 setting found");
    await page.keyboard.press("Tab"); // Clear, then the native result link.
    await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
    await expect(page.locator("#displayTimeZone-control")).toBeFocused();
    assert.equal(await page.locator("#displayTimeZone").inputValue(), "");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), null);
    await category(page, "connection");
    assert.equal(await page.locator("#sourceSessions").inputValue(), "C:\\SYNTHETIC_DIRTY\\session-state");
    await page.locator("#sourceSessions").focus();
    await page.locator("#sourceSessions").evaluate(node => node.setSelectionRange(5, 10));
    const before = await page.locator("#sourceSessions").evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, y: scrollY }));
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 12000 });
    const after = await page.locator("#sourceSessions").evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, y: scrollY }));
    assert.deepEqual(after, before);
    await page.locator("#settingsSearch").fill("pause");
    await expect(page.locator("#settingsSearchResults")).toContainText("Unavailable: Approve or cancel the source edits");
    await page.locator("#settingsSearchResults a").filter({ hasText: "Pause or resume" }).click();
    assert.equal(await page.locator("#pauseCollection").isDisabled(), true);
    assert.equal(await page.locator("#pauseCollection").locator("..").evaluate(node => node === document.activeElement), true);
    await category(page, "collection");
    assert.equal(await page.locator("#collectionCadence").inputValue(), "15");
    await page.locator("#settingsSearch").fill("TIME-zone");
    assert.ok(await page.locator("#settingsSearchResults mark").count() > 0);
    const queryHandle = await page.locator("#settingsSearch").elementHandle();
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 12000 });
    assert.equal(await queryHandle.evaluate(node => node === document.activeElement && node.isConnected), true);
    assert.equal(await page.locator("#settingsSearch").inputValue(), "TIME-zone");
    await page.locator("#settingsSearch").fill("<img src=x onerror=alert(1)> [.*]");
    await expect(page.locator("#settingsSearchCount")).toContainText("No settings match");
    assert.equal(await page.locator("#settingsSearchResults img").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#settingsSearch").inputValue(), "");
    assert.equal(await page.locator("#settingsSearchResults").isVisible(), false);
    await page.locator("#settingsSearch").fill("cadence");
    await navigateMain(page, "home"); await page.goBack();
    assert.equal(await page.locator("#settingsSearch").inputValue(), "cadence");
    assert.ok(!page.url().includes("cadence"));
    assert.doesNotMatch(JSON.stringify(requests), /SYNTHETIC_DIRTY|TIME-zone|onerror|cadence/);
});

test("Collection status destinations restore visible focus on legacy routes, reload and browser history", { timeout: 45000 }, async t => {
    const { page, url, requests } = await setup(t);
    await page.locator("#settingsSearch").fill("missing history");
    await page.locator("#settingsSearchResults a[data-setting=issues]").click();
    await expect(page.locator("#collectionIssuesTitle")).toBeFocused();
    assert.match(page.url(), /#collection-status\?setting=issues/);
    assert.equal(await page.locator("#settingsView").isVisible(), false);
    assert.equal(await page.locator(".history-issue").count(), 0);
    assert.equal(await page.locator("#collectionSetup").evaluate(node => node.open), false);
    await page.locator("#issueSearch").fill("unavailable");
    await expect(page.locator("#issueSearchCount")).toHaveText("19 of 19 chats");
    assert.equal(await page.locator(".history-issue").count(), 6);
    await page.goBack();
    await expect(page.locator("#settingsView")).toBeVisible();
    assert.equal(await page.locator("#settingsSearch").inputValue(), "missing history");
    await page.goForward();
    await expect(page.locator("#issueSearch")).toHaveValue("unavailable");
    await page.reload(); await ready(page);
    await expect(page.locator("#issueSearchCount")).toHaveText("19 of 19 chats");
    await page.locator("#issueSearch").focus(); await page.keyboard.press("Escape");
    await expect(page.locator("#issueSearch")).toHaveValue("");
    for (const [legacy, target] of [
        ["#settings?issues=1", "collectionIssuesTitle"],
        ["#settings?section=diagnostics", "pageTitle"],
        ["#settings?setting=issues", "collectionIssuesTitle"],
        ["#settings?setting=advanced", "collectionSetup"],
        ["#settings?section=diagnostics&setting=collection-details", "collectionSetup"],
    ]) {
        await page.goto(url + legacy); await ready(page);
        const focus = target === "collectionSetup" ? page.locator("#collectionSetup>summary") : page.locator("#" + target);
        await expect(focus).toBeFocused();
        await expect(page.locator("#collectionStatusView")).toBeVisible();
        await expect(page.locator("#breadcrumbs")).toHaveText("Home/Collection status");
        assert.equal(await page.locator(".primary-navigation [aria-current=page]").getAttribute("data-nav"), "collection-status");
        if (target === "collectionSetup") assert.equal(await page.locator("#collectionSetup").evaluate(node => node.open), true);
    }
    await page.getByRole("link", { name: "Source & permission", exact: true }).click();
    await expect(page.locator("#approvedSourceDetails")).toBeVisible();
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    assert.doesNotMatch(JSON.stringify(requests), /missing history|unavailable/);
});

test("Collection status keeps unchecked, paused, pending, zero and failed states distinct", { timeout: 30000 }, async t => {
    const { page, url, setStatus, status } = await setup(t);
    const initial = structuredClone(status());
    const zero = { eligible: 0, readable: 0, unavailable: 0, limited: 0, pending: 0, affected: 0, excluded: {} };
    for (const [patch, label, coverage] of [
        [{ config: null, discovery: null, historyCoverage: null }, "Not connected", /not available until a check completes/],
        [{ discovery: null, historyCoverage: null, lastCheckedAt: null }, "Checking history", /not available until a check completes/],
        [{ state: "paused", config: { ...initial.config, enabled: false }, historyCoverage: zero }, "Collection paused", /0 of 0 eligible chats/],
        [{ historyCoverage: { ...zero, eligible: 2, pending: 2 } }, "Collection active", /0 of 2 eligible chats/],
        [{ historyCoverage: zero }, "Collection active", /0 of 0 eligible chats/],
        [{ error: "Synthetic file-access failure " + "x".repeat(100), historyCoverage: zero }, "Collection cannot check history", /Last known coverage: 0 of 0 eligible chats/],
    ]) {
        setStatus({ ...initial, lastCheckedAt: "2026-10-05T12:00:00Z", historyIssues: [], error: "", ...patch });
        await page.goto(url + "#collection-status"); await ready(page);
        await expect(page.locator("#collectionStatus")).toHaveText(label);
        await expect(page.locator("#collectionCoverageCounts")).toContainText(coverage);
        if (patch.historyCoverage === null) await expect(page.locator("#collectionIssueLabel")).toHaveText("History not checked");
        if (patch.historyCoverage?.pending) await expect(page.locator("#collectionCoveragePending")).toContainText("2 chats are awaiting or still importing");
        if (patch.error) {
            await expect(page.locator("#settingsDiagnosticError")).toHaveText(patch.error);
            await expect(page.locator("#settingsDiagnosticError")).toBeVisible();
            assert.equal(await page.locator("#collectionStatus").getAttribute("data-severity"), "error");
        }
        assert.equal(await page.locator("#collectionNotice").isVisible(), false, "Status is not duplicated above its own page.");
    }
});

test("authoritative zero issues has one message while real no-match searches retain their controls", { timeout: 30000 }, async t => {
    const { page, url, setStatus, status, requests } = await setup(t);
    const real = structuredClone(status());
    const zero = { eligible: 19, readable: 19, unavailable: 0, limited: 0, pending: 0, affected: 0, excluded: {} };
    setStatus({ ...real, lastCheckedAt: "2026-10-05T12:00:00Z", historyCoverage: zero, historyIssues: [] });
    await page.goto(url + "#collection-status"); await ready(page);
    const issues = page.locator("#collectionIssues");
    await expect(issues.getByText("No history gaps reported", { exact: true })).toBeVisible();
    assert.equal(await issues.getByText("No history gaps reported", { exact: true }).count(), 1);
    await expect(page.locator("#issueSearch")).toBeHidden();
    await expect(page.locator("#issueSearchCount")).toBeHidden();
    await expect(page.locator("#collectionIssueCounts")).toBeHidden();
    await expect(page.locator("#collectionIssueGroups")).toBeHidden();
    await expect(page.locator("#collectionIssuesBody>.settings-help")).toBeHidden();
    setStatus({ ...real, lastCheckedAt: "2026-10-05T12:00:00Z" });
    await page.reload(); await ready(page);
    await expect(page.locator("#issueSearch")).toBeVisible();
    await page.locator("#issueSearch").fill("no recorded issue matches this");
    await expect(page.locator("#issueSearchCount")).toHaveText("0 of 19 chats");
    await expect(page.locator("#collectionIssueGroups")).toContainText("No affected Copilot chats match");
    await expect(page.locator("#collectionIssueCounts")).toBeVisible();
    await expect(page.locator("#collectionIssuesBody>.settings-help")).toBeVisible();
    await expect(issues.getByText("No history gaps reported", { exact: true })).toHaveCount(0);
    setStatus({ historyCoverage: zero, historyIssues: [] });
    await page.reload(); await ready(page);
    await expect(page.locator("#issueSearch")).toBeVisible();
    await expect(page.locator("#issueSearch")).toHaveValue("no recorded issue matches this");
    await expect(page.locator("#issueSearchCount")).toHaveText("0 of 0 chats");
    await page.locator("#clearIssueSearch").click();
    await expect(page.locator("#issueSearch")).toBeHidden();
    await expect(page.locator("#collectionIssuesTitle")).toBeFocused();
    await expect(issues.getByText("No history gaps reported", { exact: true })).toBeVisible();
    setStatus({ historyCoverage: null, historyIssues: [], lastCheckedAt: null, discovery: null });
    await page.reload(); await ready(page);
    await expect(page.locator("#collectionIssueLabel")).toHaveText("History not checked");
    await expect(page.locator("#issueSearch")).toBeHidden();
    await expect(issues.getByText("No history gaps reported", { exact: true })).toHaveCount(0);
    assert.ok(requests.every(request => ["/api/snapshot", "/api/collection/status"].includes(request.url)));
});

test("Collection status explains every reason and reflows at all required theme, width and text sizes", { timeout: 90000 }, async t => {
    const { page, url, setStatus } = await setup(t);
    const model = createCollectionStatus(), reasons = Object.keys(model.reasons);
    const rows = [
        { error: "Synthetic failure", errorCode: "ENOENT" },
        { error: "Synthetic failure", errorCode: "EACCES" },
        { error: "Synthetic failure", errorCode: "EIO" },
        { error: "Synthetic failure", errorCode: "HISTORY_STARTUP_INVALID" },
        { error: "Synthetic failure", errorCode: "UNCLASSIFIED" },
        { scanned: true, cursor: { droppedBytes: 20 } },
        { scanned: true, cursor: { malformedLines: 2 } },
        { scanned: true, cursor: { oversizedLines: 2 } },
        { scanned: true, diagnostics: { contextEvictions: 2 } },
    ].map((row, i) => ({ ...row, sessionId: `reason-${i}` }));
    const sources = rows.map((row, i) => ({ sessionId: row.sessionId, name: `Synthetic ${reasons[i]} chat with a long uninterrupted name ${"x".repeat(100)}`, eligible: true }));
    const { summary, issues } = model.coverage(sources, rows, [sources[0].sessionId]);
    setStatus({ historyCoverage: summary, historyIssues: issues, lastCheckedAt: "2026-10-05T12:00:00Z",
        metrics: { truncatedSources: 1, oversizedLines: 2, malformedLines: 2, contextEvictions: 2, credentialExclusions: 0, partialSources: 0, lastBytesRead: 2048, lastDurationMs: 8 } });
    await page.goto(url + "#collection-status"); await ready(page);
    await expect(page.locator(".history-reason")).toHaveCount(reasons.length);
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.locator("#issueSearch").fill("");
        const group = page.locator(".history-reason").first();
        if (await group.evaluate(node => node.open)) await group.locator(">summary").click();
        if (await page.locator("#collectionSetup").evaluate(node => node.open)) await page.locator("#collectionSetup>summary").click();
        const measure = await page.locator("#collectionStatusView").evaluate(root => ({
            words: root.innerText.trim().split(/\s+/).length,
            controls: [...root.querySelectorAll("a,button,input,summary")].filter(n => n.checkVisibility()).length,
            overflow: document.documentElement.scrollWidth > innerWidth,
            hiddenFocus: Boolean(document.activeElement.closest("[hidden]")),
            clippedNav: [...document.querySelectorAll(".primary-navigation a")].filter(n => n.checkVisibility()).flatMap(n => {
                const rect = n.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(n);
                return [...range.getClientRects()].filter(r => r.width && (r.left < rect.left - 1 || r.right > rect.right + 1)).map(() => n.textContent);
            }),
        }));
        assert.equal(measure.overflow, false, `${theme}/${width}/${scale}`);
        assert.deepEqual(measure.clippedNav, [], `${theme}/${width}/${scale}: full navigation label`);
        if (proofs) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `collection-status-${theme}-${width}-${scale * 100}.png`), fullPage: true });
        }
        await group.locator(">summary").click();
        if (!await group.locator(".history-issue").evaluate(node => node.open)) await group.locator(".history-issue>summary").click();
        await page.locator("#collectionSetup>summary").click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width}/${scale}: expanded details`);
        if (width === 375 || scale === 2 && width <= 1200) {
            assert.equal(await page.locator("#collectionDiagnostics .facts").first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 1, "Technical labels and values stack instead of squeezing into narrow columns.");
        }
        assert.match(await group.innerText(), /file was not found.*Previously collected evidence/s);
        assert.doesNotMatch(await page.locator("#collectionDiagnostics").innerText(), /Cadence|eligible mappings|correlation-context evictions|truncated initial tails/);
        if (proofs && (width === 1200 && scale === 1 || width === 375 && scale === 2)) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `collection-expanded-${theme}-${width}-${scale * 100}.png`), fullPage: true });
        }
        for (const rect of await page.locator("#collectionStatusView summary").evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).map(n => ({ height: n.getBoundingClientRect().height })))) assert.ok(rect.height >= 44);
        const nesting = await page.locator("#collectionStatusView").evaluate(root => Math.max(0, ...[...root.querySelectorAll("details")].map(n => {
            let depth = 1; while ((n = n.parentElement)) if (n.tagName === "DETAILS") depth++; return depth;
        })));
        assert.equal(nesting, 3, "Reason, chat, optional technical details; no outer issue disclosure");
        measurements.push({ theme, width, scale, ...measure, expandedDetailNesting: nesting });
    }
    for (const [index, code] of reasons.entries()) {
        await page.locator("#issueSearch").fill(model.reasons[code].label);
        await expect(page.locator("#issueSearchCount")).toHaveText("1 of 9 chats");
        await expect(page.locator(".history-issue")).toHaveCount(1);
        assert.match(await page.locator(".history-reason-body").innerText(), new RegExp(model.reasons[code].guidance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal((await page.locator(".history-issue").getAttribute("data-disclosure-key")), `history-issue:reason-${index}`);
    }
    if (proofs) await writeFile(path.join(proofs, "collection-status-layout.json"), JSON.stringify(measurements, null, 2));
});

test("unapproved and paused Settings results accurately locate permission boundaries", { timeout: 30000 }, async t => {
    const { page, setStatus, status } = await setup(t, false);
    await page.locator("#settingsSearch").fill("resume");
    await expect(page.locator("#settingsSearchResults")).toContainText("Requires an approved source");
    await page.locator("#settingsSearchResults a").click();
    await expect(page.locator("#reviewSource")).toBeFocused();
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#settingsSearch").inputValue(), "resume");
    await expect(page.locator("#settingsSearchResults")).toContainText("Requires an approved source");
    setStatus({ config: { approved: true, enabled: false, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", windowDays: 30, pollSeconds: 5 }, configVersion: 2, connected: true });
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 12000 });
    await expect(page.locator("#pauseCollection")).toHaveText("Resume collection");
    await page.locator("#settingsSearchResults a").click();
    await expect(page.locator("#pauseCollection")).toBeFocused();
    assert.equal(status().config.enabled, false);
});

test("saved reports and report membership search the entire retained list without expanding selection", { timeout: 45000 }, async t => {
    const { page, requests } = await setup(t);
    await navigateMain(page, "reports");
    await page.locator("#bundles>summary").click();
    await expect(page.locator("#bundleList")).toContainText("1-6 of 15 saved reports");
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await expect(page.locator("#bundleList")).toContainText("7-12 of 15 saved reports");
    await page.locator("#savedReportSearch").fill("ZEPHYR img");
    await expect(page.locator("#savedReportSearchCount")).toHaveText("1 of 15 saved reports match.");
    await expect(page.locator("#bundleList")).toContainText("Report-Zephyr <img>");
    assert.equal(await page.locator("#bundleList img").count(), 0);
    await page.locator("#savedReportSearch").fill("UNIQUE RETAINED");
    await expect(page.locator("#bundleList")).toContainText("No saved reports match");
    await page.keyboard.press("Escape");
    await expect(page.locator("#bundleList")).toContainText("7-12 of 15 saved reports");
    await chooseReportScope(page, "all");
    await page.locator("#reportRequests>summary").click();
    await expect(page.locator("#reportList")).toContainText("1-4 of 19 report requests");
    const summary = await page.locator("#scopeSummary").innerText();
    await page.locator("#reportRequestSearch").fill("unique-retained");
    await expect(page.locator("#reportRequestSearchCount")).toHaveText("1 of 19 report requests shown. All 19 remain included.");
    await expect(page.locator("#reportList")).toContainText("UNIQUE RETAINED final-request");
    assert.equal(await page.locator("#scopeSummary").innerText(), summary);
    await page.locator("#reportRequestSearch").fill("<svg> nonmatching");
    await expect(page.locator("#reportList")).toContainText("No report requests match");
    assert.equal(await page.locator("#scopeSummary").innerText(), summary);
    await page.locator("#clearReportRequestSearch").click();
    await expect(page.locator("#reportList")).toContainText("1-4 of 19 report requests");
    assert.doesNotMatch(JSON.stringify(requests), /ZEPHYR img|unique-retained|nonmatching/);
});

test("issue and Activity searches precede pagination, preserve canonical counts and intersect filters", { timeout: 45000 }, async t => {
    const { page, url, requests } = await setup(t);
    await page.goto(url + "#settings?issues=1"); await ready(page);
    await page.locator(".history-reason>summary").first().click();
    await expect(page.locator(".history-issue")).toHaveCount(6);
    await page.getByRole("button", { name: "Next affected Copilot chats", exact: true }).click();
    await page.locator("#issueSearch").fill("ZEPHYR-end <img>");
    await expect(page.locator("#issueSearchCount")).toHaveText("1 of 19 chats");
    await expect(page.locator(".history-issue")).toHaveCount(1);
    await expect(page.locator(".history-issue")).toContainText("Zephyr-end <img> chat");
    await page.locator("#issueSearch").fill("no such reason [.*]");
    await expect(page.locator("#collectionIssueGroups")).toContainText("No affected Copilot chats match");
    await page.keyboard.press("Escape");
    await expect(page.locator("#collectionIssueGroups")).toContainText("7-12 of 19 affected Copilot chats");
    await navigateMain(page, "activity");
    await expect(page.locator("#activityPager")).toContainText("1-8 of 20");
    await page.locator("#activitySearch").fill("ZePhYr end <img>");
    await expect(page.locator("#activityPager")).toContainText("1-1 of 1");
    await expect(page.locator("#activityListSummary")).toContainText("1 request group in 1 Copilot chat");
    await expect(page.locator("#activityList")).toContainText("1 Work IQ tool call");
    await selectActivityOption(page, "outcomeFilter", "failure");
    await expect(page.locator("#activityList")).toContainText("No requests match");
    await selectActivityOption(page, "outcomeFilter", "all");
    await page.locator("#activitySearch").fill("metadata-only <svg>");
    await expect(page.locator("#activityListSummary")).toContainText("0 request groups");
    await expect(page.locator("#activityListSummary")).toContainText("1 Copilot chat without matching evidence");
    assert.equal(await page.locator("#activityList svg:not([data-fluent-icon])").count(), 0);
    await page.locator("#clearActivitySearch").click();
    await expect(page.locator("#activityPager")).toContainText("1-8 of 20");
    assert.doesNotMatch(JSON.stringify(requests), /ZePhYr|ZEPHYR-end|metadata-only <svg>|no such reason/);
});

test("issue status search matches displayed unavailable/limited subsets with mixed-warning precedence and deduplication", { timeout: 30000 }, async t => {
    const { page, url, setStatus, requests } = await setup(t);
    const sources = [
        { sessionId: "missing-only", name: "Synthetic Atlas", eligible: true },
        { sessionId: "missing-and-truncated", name: "Synthetic Beacon", eligible: true },
        { sessionId: "context-only", name: "Synthetic Cedar", eligible: true },
        { sessionId: "oversized-and-context", name: "Synthetic Delta", eligible: true },
        { sessionId: "healthy", name: "Synthetic Echo", eligible: true },
    ];
    const { summary, issues } = createCollectionStatus().coverage([...sources, sources[1], sources[3]], [
        { sessionId: sources[0].sessionId, error: "Synthetic missing history", errorCode: "ENOENT" },
        { sessionId: sources[1].sessionId, error: "Synthetic missing history", errorCode: "ENOENT", cursor: { droppedBytes: 100 }, diagnostics: { contextEvictions: 2 } },
        { sessionId: sources[2].sessionId, scanned: true, diagnostics: { contextEvictions: 1 } },
        { sessionId: sources[3].sessionId, scanned: true, cursor: { oversizedLines: 2 }, diagnostics: { contextEvictions: 3 } },
        { sessionId: sources[4].sessionId, scanned: true },
    ]);
    assert.equal(summary.unavailable, 2);
    assert.equal(summary.limited, 2);
    assert.equal(issues.length, 4);
    setStatus({ historyCoverage: summary, historyIssues: issues });
    await page.goto(url + "#settings?issues=1"); await ready(page);
    await expect(page.locator("#collectionIssueLabel")).toContainText("4 chats with history gaps");
    const counts = await page.locator("#collectionIssueCounts").innerText();
    for (const [query, ids] of [
        ["UnAvAiLaBlE", ["missing-only", "missing-and-truncated"]],
        ["limited-history", ["context-only", "oversized-and-context"]],
        ["missing", ["missing-only", "missing-and-truncated"]],
        ["context", ["missing-and-truncated", "context-only", "oversized-and-context"]],
        ["unrelated <img> [.*]", []],
    ]) {
        await page.locator("#issueSearch").fill(query);
        await expect(page.locator("#issueSearchCount")).toHaveText(`${ids.length} of 4 chats`);
        assert.deepEqual((await page.locator(".history-issue").evaluateAll(nodes => nodes.map(node => node.dataset.disclosureKey.replace("history-issue:", "")))).sort(), [...ids].sort());
        assert.equal(await page.locator("#collectionIssueCounts").innerText(), counts);
        assert.ok(!page.url().includes(encodeURIComponent(query)));
    }
    await page.locator("#clearIssueSearch").click();
    await expect(page.locator("#issueSearchCount")).toHaveText("4 of 4 chats");
    assert.equal(await page.locator("#collectionIssueCounts").innerText(), counts);
    assert.doesNotMatch(JSON.stringify(requests), /UnAvAiLaBlE|limited-history|unrelated/);
});

test("single-pane Settings reflows in both themes, touch, compact containers and 200% text", { timeout: 90000 }, async t => {
    const { page } = await setup(t);
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        for (const section of ["display", "connection", "collection"]) {
            await category(page, section);
            assert.equal(await page.locator("[data-settings-section]:visible").count(), 1);
            const measured = await page.evaluate(() => {
                const root = document.documentElement, panes = [...document.querySelectorAll("[data-settings-section]")];
                const controls = [...document.querySelectorAll("#settingsView a, #settingsView button, #settingsView input, #settingsView summary")].filter(node => node.checkVisibility());
                const bad = controls.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1 || r.height < 43; }).map(node => node.id || node.textContent);
                return { overflow: root.scrollWidth > innerWidth, bad, hiddenFocusable: panes.filter(node => node.hidden).some(node => node.contains(document.activeElement)) };
            });
            assert.deepEqual(measured, { overflow: false, bad: [], hiddenFocusable: false }, `${theme}/${width}/${scale}/${section}`);
        }
        await page.locator("#settingsSearch").fill("permission");
        const results = page.locator("#settingsSearchResults a");
        assert.ok(await results.count() > 1);
        for (const box of await results.evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, height: rect.height, overflow: node.scrollWidth > node.clientWidth };
        }))) assert.ok(box.left >= 0 && box.right <= width && box.height >= 44 && !box.overflow, `${theme}/${width}/${scale}: search result fits`);
        if (width === 1200 && scale === 1) {
            for (const state of ["rest", "hover", "focus"]) {
                if (state === "hover") await results.first().hover();
                if (state === "focus") await results.first().focus();
                const colors = await results.first().evaluate(node => [...node.querySelectorAll("strong,span,mark")].map(child => {
                    let background = child;
                    while (getComputedStyle(background).backgroundColor === "rgba(0, 0, 0, 0)") background = background.parentElement;
                    return { ink: getComputedStyle(child).color, surface: getComputedStyle(background).backgroundColor };
                }));
                for (const color of colors) {
                    const ratio = contrast(color.ink, color.surface);
                    assert.ok(ratio >= 4.5, `${theme}/${state}: search text contrast ${ratio}`);
                    measurements.push({ theme, state, family: "search-result", contrast: ratio });
                }
            }
        }
        if (proofs && [375, 1200].includes(width)) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `settings-search-${theme}-${width}-${scale * 100}.png`), fullPage: true });
        }
        await page.locator("#clearSettingsSearch").click();
        await category(page, "display");
        if (width === 1200 && scale === 1) {
            const nav = page.locator("#settingsCategoryNav [aria-current=page]");
            for (const state of ["selected", "hover", "focus"]) {
                if (state === "hover") await nav.hover();
                if (state === "focus") await nav.focus();
                const colors = await nav.evaluate(node => ({ ink: getComputedStyle(node).color, surface: getComputedStyle(node).backgroundColor }));
                assert.ok(contrast(colors.ink, colors.surface) >= 4.5, `${theme}/${state} contrast`);
                measurements.push({ theme, state, contrast: contrast(colors.ink, colors.surface) });
            }
        }
        if (proofs) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.screenshot({ path: path.join(proofs, `settings-${theme}-${width}-${scale * 100}.png`), fullPage: true });
        }
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator("#settingsView").evaluate(node => node.style.maxWidth = "480px");
    await expect(page.locator("#settingsCategorySummary")).toBeVisible();
    await category(page, "collection");
    await page.locator("#settingsCategorySummary").tap();
    await page.locator("#settingsCategoryNav [data-category=connection]").tap();
    await expect(page.locator("#connectionTitle")).toBeVisible();
    if (proofs) await writeFile(path.join(proofs, "settings-measurements.json"), JSON.stringify(measurements, null, 2));
});
