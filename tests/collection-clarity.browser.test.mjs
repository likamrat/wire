import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { fixture, exportCatalogFor, automaticScoreOffSummary, chooseTheme } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_COLLECTION_PROOFS;
const captureOnly = process.env.WORKIQ_COLLECTION_CAPTURE_ONLY === "1";
const render = process.env.WORKIQ_COLLECTION_BASELINE
    ? (await import(pathToFileURL(path.join(process.env.WORKIQ_COLLECTION_BASELINE, "lib", "render.mjs")))).renderHtmlShell
    : renderHtmlShell;
const model = createCollectionStatus();
const checked = "2026-10-09T16:00:00.000Z";

async function setup(t) {
    const sessions = Array.from({ length: 971 }, (_, i) => ({
        sessionId: `clarity-chat-${i}`, name: i === 18 ? "Zephyr rollout <img> review" : `Release planning ${i + 1}`,
        projectId: "clarity-project", project: "Release readiness", eligible: true,
    }));
    const cursors = sessions.map((row, i) => ({
        sessionId: row.sessionId, scanned: i >= 19, lastAttemptAt: checked,
        ...(i < 19 ? { error: "Synthetic missing file", errorCode: "ENOENT" }
            : i < 35 ? { cursor: { droppedBytes: 100, oversizedLines: 2 }, diagnostics: { contextEvictions: 1 } }
                : i < 53 ? { cursor: { oversizedLines: 1 } }
                    : i < 88 ? { diagnostics: { contextEvictions: 1 } } : {}),
    }));
    const gaps = model.coverage(sessions, cursors, ["clarity-chat-0"]);
    const record = { ...fixture("clarity-request"), sourceSessionId: "clarity-chat-0", sourceSessionName: sessions[0].name };
    let status = {
        revision: 1, configVersion: 1, state: "collecting-on-interval", connected: true,
        config: { approved: true, enabled: true, appDbPath: "C:\\invented\\data.db", sessionRoot: "C:\\invented\\history", windowDays: 30, pollSeconds: 5 },
        cadence: { pollSeconds: 5 }, metrics: {}, lastCheckedAt: checked, lastNewDataAt: "2026-10-08T23:00:00.000Z",
        discovery: { counts: { sessions: 971, eligible: 971, dispositions: { eligible: 971 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: gaps.summary, historyIssues: gaps.issues,
    };
    const initial = structuredClone(status), requests = [], errors = [], denied = [];
    let summaryFailure = false, detailsFailure = false, detailsHold, releaseDetails;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            return res.end(render("a".repeat(64), "collection-clarity-fixture"));
        }
        if (req.url === "/favicon.ico") return res.writeHead(204).end();
        let body = ""; for await (const part of req) body += part;
        const input = body ? JSON.parse(body) : {};
        requests.push({ url: req.url, input });
        res.setHeader("Content-Type", "application/json");
        const { historyIssues, ...summary } = status;
        if (req.url === "/api/snapshot") return res.end(JSON.stringify({
            revision: 1, scenarios: [record], sessions, exports: [], exportCatalog: exportCatalogFor([record]),
            coverage: { notes: [] }, collection: summary, analytics: { ...buildActivityAnalytics([record], input), revision: 1 },
        }));
        if (req.url === "/api/collection/status") {
            if (input.details && detailsHold) await detailsHold;
            if (input.details ? detailsFailure : summaryFailure) return res.writeHead(503).end(JSON.stringify({ error: "Synthetic status read unavailable." }));
            return res.end(JSON.stringify(input.details ? status : summary));
        }
        if (req.url === "/api/assessment/status") return res.end(JSON.stringify({ schemaVersion: 1, consent: { state: "disabled", revision: 0 } }));
        if (req.url === "/api/evaluation/automatic/summary") return res.end(JSON.stringify(automaticScoreOffSummary()));
        if (req.url === "/api/record/status") return res.end(JSON.stringify({ attempt: null }));
        denied.push(req.url);
        return res.writeHead(403).end(JSON.stringify({ error: "Fixture permits read-only presentation requests only." }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1614, height: 1100 }, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    t.after(async () => {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
        assert.deepEqual(denied, [], "No writes, collection checks, providers or approval changes");
    });
    async function ready() {
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#collectionIssuesMessage")).toBeHidden();
        await page.evaluate(() => document.fonts.ready);
    }
    await page.goto(url + "#collection-status");
    await ready();
    return { page, initial, sessions, requests, ready, setStatus: patch => { status = { ...initial, ...patch }; },
        failSummary: value => { summaryFailure = value; }, failDetails: value => { detailsFailure = value; },
        holdDetails: () => { detailsHold = new Promise(resolve => { releaseDetails = resolve; }); },
        releaseDetails: () => { releaseDetails(); detailsHold = undefined; } };
}

async function measure(page) {
    return page.locator("#collectionStatusView").evaluate(root => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { width: r.width, height: r.height, x: r.x, right: r.right };
        };
        const lines = node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.y))).size;
        };
        const controls = [...root.querySelectorAll("a,button,input,summary")].filter(node => node.checkVisibility());
        const text = [...root.querySelectorAll("h2,p,a,label,summary")].filter(node => node.checkVisibility());
        return {
            viewport: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth,
            page: box(root), search: box(root.querySelector("#issueSearch")),
            labels: [...root.querySelectorAll(".history-reason>summary,.collection-status-actions a,h2,#collectionStatus")]
                .filter(node => node.checkVisibility()).map(node => ({ text: node.textContent, lines: lines(node), ...box(node) })),
            controls: controls.map(node => ({ text: node.textContent || node.id, ...box(node) })),
            font: getComputedStyle(root).fontFamily,
            readingSize: parseFloat(getComputedStyle(root.querySelector("#collectionStatusGuidance")).fontSize),
            colors: text.map(node => {
                let background = node;
                while (background.parentElement && getComputedStyle(background).backgroundColor === "rgba(0, 0, 0, 0)") background = background.parentElement;
                return { text: node.textContent, color: getComputedStyle(node).color, background: getComputedStyle(background).backgroundColor };
            }),
        };
    });
}

async function capture(page, name) {
    if (!proofs) return;
    await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}

test("collection page has measured compact controls, responsive states and local-only browsing", { timeout: 90000 }, async t => {
    const { page, requests } = await setup(t), measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const [name, width, textSize] of [["desktop", 1614, 100], ["narrow", 375, 100], ["text200", 1614, 200], ["narrow-text200", 375, 200]]) {
            await page.setViewportSize({ width, height: 1100 });
            await page.evaluate(async size => {
                document.documentElement.style.fontSize = `${size}%`;
                document.activeElement?.blur();
                window.scrollTo(0, 0);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }, textSize);
            const current = await measure(page);
            measurements.push({ theme, name, ...current });
            assert.equal(current.pageOverflow, false, `${theme}/${name} page overflow`);
            if (!captureOnly) {
                assert.ok(current.controls.every(control => control.height >= 44), `${theme}/${name} 44px targets`);
                assert.ok(current.readingSize >= 16, "Reading typography is not shrunk to fit");
                assert.match(current.font, /^Arial,/);
                assert.ok(current.colors.every(pair => contrast(pair.color, pair.background) >= 4.5), `${theme}/${name} text contrast`);
                if (name === "desktop") {
                    assert.ok(current.search.width <= 540 && current.search.width >= 280, "Search has a useful, proportionate width");
                    assert.ok(current.search.width / current.page.width < .6, "Search does not stretch across the page");
                    assert.ok(current.labels.every(label => label.lines === 1), JSON.stringify(current.labels));
                }
            }
            if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-${name}.png`), fullPage: true });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "measurements.json"), JSON.stringify(measurements, null, 2));
    if (captureOnly) return;
    await page.setViewportSize({ width: 1614, height: 1100 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await expect(page.locator("#collectionCoverageCounts")).toContainText("952 of 971");
    await expect(page.locator("#collectionIssueLabel")).toHaveText("88 chats with history gaps");
    await expect(page.locator("#collectionIssueCounts")).toContainText("19 unavailable");
    await expect(page.locator("#collectionIssueCounts")).toContainText("69 limited");
    await expect(page.locator("#collectionStatusGuidance")).toContainText("No action is needed");
    await page.locator(".history-reason>summary").first().click();
    await expect(page.locator(".history-issue")).toHaveCount(6);
    await page.getByRole("button", { name: "Next affected Copilot chats", exact: true }).click();
    await expect(page.locator("#collectionIssueGroups")).toContainText("7-12 of 19");
    await page.locator("#issueSearch").fill("Zephyr <img>");
    await expect(page.locator(".history-issue")).toHaveCount(1);
    await expect(page.locator("#issueSearchCount")).toHaveText("1 of 88 chats");
    assert.equal(await page.locator("#collectionIssueGroups img").count(), 0);
    await page.locator(".history-issue>summary").click();
    await expect(page.locator(".history-issue-detail")).toContainText("No evidence has been collected");
    await page.getByRole("link", { name: "Open chat activity", exact: true }).click();
    await expect(page.locator("#pageTitle")).toHaveText("Zephyr rollout <img> review");
    assert.match(page.url(), /session=clarity-chat-18/);
    await expect(page.locator("#contextBack")).toHaveText("Back to history gaps");
    await page.goBack();
    await expect(page.locator("#issueSearch")).toHaveValue("Zephyr <img>");
    await expect(page.getByRole("link", { name: "Open chat activity", exact: true })).toBeFocused();
    await page.getByRole("link", { name: "Open chat activity", exact: true }).click();
    await page.locator("#contextBack").click();
    await expect(page.locator("#issueSearch")).toHaveValue("Zephyr <img>");
    await expect(page.getByRole("link", { name: "Open chat activity", exact: true })).toBeFocused();
    await page.locator("#issueSearch").fill("absent [.*] match");
    await expect(page.locator("#collectionIssueGroups")).toContainText("No affected Copilot chats match");
    await page.locator("#issueSearch").press("Escape");
    await expect(page.locator("#issueSearch")).toHaveValue("");
    await expect(page.locator("#collectionIssueGroups")).toContainText("7-12 of 19");
    await expect(page.locator("#issueSearch")).toBeFocused();
    const focus = await page.locator("#issueSearch").evaluate(node => getComputedStyle(node).outlineStyle);
    assert.notEqual(focus, "none");
    await page.locator(".history-reason>summary").nth(1).click();
    await page.locator(".history-reason").nth(1).locator(".history-issue>summary").first().click();
    await expect(page.locator(".history-reason").nth(1)).toContainText("64 MiB");
    await expect(page.locator(".history-reason").nth(1)).toContainText("Another check does not remove");
    await expect(page.locator(".history-reason").nth(1)).toContainText("limited working memory");
    await page.locator("#collectionSetup>summary").click();
    await expect(page.locator("#collectionSetup")).toContainText("A verified location is not a successful read");
    await expect(page.locator("#refreshBtn")).toBeVisible();
    await page.locator("#recorderDiagnostics>summary").click();
    await expect(page.locator("#recorderPurpose")).toContainText("not collection");
    await expect(page.locator("#recorderEffect")).toContainText("cannot verify Work IQ");
    assert.ok(requests.filter(request => request.url === "/api/collection/status").some(request => request.input.details === true));
    assert.ok(!JSON.stringify(requests).includes("Zephyr"), "Search never leaves the browser");
    if (proofs) await page.screenshot({ path: path.join(proofs, "expanded-details.png"), fullPage: true });
});

test("collection guidance distinguishes active, paused, unavailable, unchecked and failed states", { timeout: 90000 }, async t => {
    if (captureOnly) { t.skip("Capture-only baseline run"); return; }
    const { page, initial, sessions, setStatus, ready } = await setup(t);
    const healthy = { ...initial.historyCoverage, readable: 971, unavailable: 0, limited: 0, affected: 0, groups: {} };
    const cases = [
        ["healthy", { historyCoverage: healthy, historyIssues: [] }, "Collection active", "No action is needed", "No history gaps reported"],
        ["paused", { state: "paused", config: { ...initial.config, enabled: false } }, "Collection paused", "Resume in Settings", "88 chats with history gaps"],
        ["paused-no-gaps", { state: "paused", config: { ...initial.config, enabled: false }, historyCoverage: healthy, historyIssues: [] }, "Collection paused", "Resume in Settings", "No history gaps reported at last check"],
        ["not-connected", { state: "disconnected", config: null, connected: false, discovery: null, historyCoverage: null, historyIssues: [], lastCheckedAt: null }, "Not connected", "Collection is optional", "History not checked"],
        ["disconnected", { state: "disconnected", connected: false }, "Collection disconnected", "not connected", "88 chats with history gaps"],
        ["incompatible", { state: "error", connected: false, error: "Unsupported Copilot metadata schema.", discovery: null, historyCoverage: null, historyIssues: [] }, "Collection cannot check history", "Review the source", "History not checked"],
        ["error-retained", { state: "error", connected: false, error: "Approved source cannot be read." }, "Collection cannot check history", "Previously collected evidence is kept", "88 chats with history gaps"],
        ["error-no-known-gaps", { state: "error", error: "Approved source cannot be read.", historyCoverage: healthy, historyIssues: [] }, "Collection cannot check history", "Previously collected evidence is kept", "Current history coverage unavailable"],
        ["stopped", { state: "stopped" }, "Collection stopped", "Collection is not running", "88 chats with history gaps"],
        ["first-check", { discovery: null, historyCoverage: null, historyIssues: [], lastCheckedAt: null }, "Checking history", "first check", "History not checked"],
        ["checking", { state: "collecting" }, "Checking history", "You can keep browsing", "88 chats with history gaps"],
        ["importing", { historyCoverage: { ...healthy, pending: 2 }, historyIssues: [] }, "Collection active", "Automatic checks will continue", "History is still importing"],
        ["empty-source", { historyCoverage: { ...healthy, eligible: 0, readable: 0 }, historyIssues: [] }, "Collection active", "No eligible local chats", "No eligible chats to check"],
        ["all-unavailable", { historyCoverage: { ...initial.historyCoverage, readable: 0, unavailable: 971, limited: 0, affected: 971, groups: { missing: 971 } },
            historyIssues: sessions.map(row => ({ ...row, reasons: ["missing"], unavailable: true, hasPriorEvidence: false })) }, "Collection active", "no chat history is currently readable", "971 chats with history gaps"],
        ["no-new-evidence", { historyCoverage: healthy, historyIssues: [], lastNewDataAt: null }, "Collection active", "No action is needed", "No history gaps reported"],
        ["new-evidence", { historyCoverage: healthy, historyIssues: [], lastNewDataAt: checked }, "Collection active", "No action is needed", "No history gaps reported"],
    ];
    for (const [name, patch, label, guidance, issues] of cases) {
        setStatus(patch);
        await page.reload(); await ready();
        await expect(page.locator("#collectionStatus")).toHaveText(label);
        await expect(page.locator("#collectionStatusGuidance")).toContainText(guidance);
        await expect(page.locator("#collectionIssueLabel")).toHaveText(issues);
        if (patch.error) {
            await expect(page.locator("#settingsDiagnosticError")).toHaveText(patch.error);
            await expect(page.locator("#collectionIssueLabel")).not.toContainText("No history gaps");
        }
        if (["not-connected", "first-check", "incompatible", "importing", "empty-source", "healthy"].includes(name)) await expect(page.locator("#issueSearch")).toBeHidden();
        if (name === "no-new-evidence") await expect(page.locator("#collectionNewActivity")).toHaveText("No new evidence collected yet");
        if (name === "new-evidence") await expect(page.locator("#collectionNewActivity")).toContainText("Last new evidence");
        for (const [width, size] of [[1614, 100], [375, 100], [1614, 200]]) {
            await page.setViewportSize({ width, height: 1100 });
            await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
            const current = await measure(page);
            assert.equal(current.pageOverflow, false, `${name}/${width}/${size} page overflow`);
            assert.ok(current.controls.every(control => control.height >= 44), `${name}/${width}/${size} target heights`);
        }
        await page.setViewportSize({ width: 1614, height: 1100 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        if (name === "paused") {
            await page.locator("#collectionStatusAction").click();
            await expect(page.locator("#pauseCollection")).toBeVisible();
            await expect(page.locator("#pauseCollection")).toHaveText("Resume collection");
            await page.goBack();
        }
        if (name === "not-connected") {
            await page.locator("#collectionStatusAction").click();
            await expect(page.locator("#reviewSource")).toBeFocused();
            await expect(page.locator("#sourceEditor")).toBeHidden();
            await expect(page.locator("#collectNow")).toBeHidden();
            await page.goBack();
        }
        if (proofs) {
            await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `state-${name}.png`), fullPage: true });
        }
    }
});

test("loading and failed status reads stay explicit, retry is read-only and search survives polling", { timeout: 45000 }, async t => {
    if (captureOnly) { t.skip("Capture-only baseline run"); return; }
    const { page, initial, setStatus, holdDetails, releaseDetails, failDetails, failSummary } = await setup(t);
    holdDetails();
    await page.reload();
    await expect(page.locator("#collectionIssuesMessage")).toContainText("Reading current local history issues");
    await expect(page.locator("#collectionIssuesMessage")).toHaveAttribute("data-pending", "true");
    await capture(page, "state-issues-loading");
    releaseDetails();
    await expect(page.locator("#collectionIssuesMessage")).toBeHidden();
    await page.locator("#issueSearch").fill("unavailable");
    await expect(page.locator("#issueSearchCount")).toHaveText("19 of 88 chats");
    await page.locator("#issueSearch").evaluate(node => {
        window.claritySearchNode = node;
        node.setSelectionRange?.(2, 4);
    });
    const snapshot = await page.locator("#collectionIssueGroups").innerHTML();
    const updated = initial.historyIssues.map(row => ({ ...row, lastAttemptAt: "2026-10-09T16:01:00.000Z" }));
    setStatus({ historyIssues: updated, lastCheckedAt: "2026-10-09T16:01:00.000Z" });
    await page.waitForFunction(() => document.querySelector("#collectionChecked").title.includes("9:01"));
    assert.equal(await page.evaluate(() => document.activeElement === window.claritySearchNode), true);
    await expect(page.locator("#issueSearch")).toHaveValue("unavailable");
    assert.equal(await page.locator("#collectionIssueGroups").innerHTML(), snapshot);
    failDetails(true);
    await expect(page.locator("#collectionIssuesMessage")).toContainText("Current issue details could not be loaded", { timeout: 12000 });
    await expect(page.locator("#collectionIssueGroups")).toBeVisible();
    await expect(page.locator("#issueSearch")).toHaveValue("unavailable");
    await capture(page, "state-issues-unavailable");
    failDetails(false);
    failSummary(true);
    await expect(page.locator("#collectionStatus")).toHaveText("Collection status unavailable", { timeout: 12000 });
    await expect(page.locator("#collectionStatusGuidance")).toContainText("last accepted check");
    await expect(page.locator("#collectionRetry")).toBeVisible();
    await expect(page.locator("#collectionStatusAction")).toBeHidden();
    await capture(page, "state-status-read-failed");
    failSummary(false);
    await page.locator("#collectionRetry").click();
    await expect(page.locator("#collectionStatus")).toHaveText("Collection active");
    await expect(page.locator("#collectionRetry")).toBeHidden();
    await expect(page.locator("#issueSearch")).toHaveValue("unavailable");
});
