import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, navigateMain, revealStoredRefresh, selectActivityOption } from "./helpers.mjs";

const proof = process.env.WIRE_HISTORY_METADATA_PROOF;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t) {
    const cleanup = [], { root, context } = await privateFixture({ after: fn => cleanup.push(fn) });
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state"),
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await mkdir(config.sessionRoot);
    const db = new DatabaseSync(config.appDbPath);
    db.exec(`PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    db.close();
    const collector = await createCollector(context, { timers: false });
    try { await collector.configure(config); } finally { await collector.close(); }
    const before = await loadBoardState(context);
    const configPath = path.join(context.dataDir, "collector", "config.json"), configBytes = await readFile(configPath);
    const denied = [], errors = [], requests = [];
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw Error("No provider in metadata proof."); },
            readSource: async () => { denied.push("evaluation-source"); throw Error("No evaluation source in metadata proof."); },
        },
    });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    let coverage = { eligible: 12, readable: 7, unavailable: 2, limited: 1, pending: 3, affected: 3,
        groups: { missing: 2, context: 1 }, excluded: { archived: 2 } };
    let receipt = {}, fail = false, block = null, checks = 0, approved = true;
    const status = () => ({
        state: approved ? "paused" : "disconnected", configVersion: approved ? "history-metadata-fixture" : "unapproved-fixture", revision: before.revision,
        config: approved ? config : null, suggestedSource: null, connected: approved,
        historyCoverage: coverage, historyIssues: coverage?.unavailable || coverage?.limited ? [
            ...Array.from({ length: coverage.unavailable || 0 }, (_, index) => ({ sessionId: `fixture-missing-${index}`, name: `Planning follow-up ${index + 1}`,
                reasons: ["missing"], unavailable: true, hasPriorEvidence: true })),
            ...Array.from({ length: coverage.limited || 0 }, (_, index) => ({ sessionId: `fixture-limited-${index}`, name: `Long working session ${index + 1}`,
                reasons: ["context"], unavailable: false, hasPriorEvidence: true })),
        ] : [], metrics: {}, cadence: { pollSeconds: 5 }, lastCheckedAt: "2026-10-20T12:00:01Z", lastNewDataAt: null,
    });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        requests.push({ method: request.method(), path: url.pathname });
        const reads = ["/api/session", "/api/session/release", "/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary"];
        if (url.origin !== new URL(runtime.url).origin || request.method() === "POST" && !reads.includes(url.pathname)) {
            denied.push(request.method() + " " + url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        await route.fulfill({ response, json: { ...payload, collection: status() } });
    });
    await page.route("**/api/collection/status", route => route.fulfill({ json: status() }));
    await page.route("**/api/collection/now", async route => {
        checks++;
        if (block) await block;
        await route.fulfill(fail ? { status: 422, json: { code: "source_mapping_unsupported", error: "This fixture's local history format is unavailable." } }
            : { json: { ...status(), check: {
                schemaVersion: 2, id: `metadata-check-${checks}`, configVersion: "history-metadata-fixture",
                revision: before.revision, beforeRevision: before.revision,
                startedAt: "2026-10-20T12:00:00Z", completedAt: "2026-10-20T12:00:01Z", outcome: "partial",
                changes: { added: 0, updated: 0, items: [] }, coverage,
                sourcesChecked: 10, eligibleSources: 12, pendingSources: 3, partialSources: 1, skippedSources: 2, ...receipt,
            } } });
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        const after = await loadBoardState(context);
        assert.deepEqual(after.evidence, before.evidence);
        assert.deepEqual(after.cards, before.cards);
        assert.deepEqual(after.exports, before.exports);
        assert.deepEqual(await readFile(configPath), configBytes);
        for (const fn of cleanup.reverse()) await fn();
        assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    });
    await page.goto(runtime.url); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return {
        page, before, requests, checks: () => checks,
        set(next) {
            coverage = next.coverage; receipt = next.receipt || {}; fail = next.fail || false;
            approved = next.approved ?? true;
        },
        pending() { let release; block = new Promise(resolve => { release = resolve; }); return () => { release(); block = null; }; },
    };
}

async function capture(page, name, facts) {
    const geometry = await page.evaluate(() => {
        const selectors = ["#freshIssues", "#collectionIssueCounts"];
        return { overflow: document.documentElement.scrollWidth - innerWidth,
            facts: selectors.map(selector => {
                const node = document.querySelector(selector), rect = node.getBoundingClientRect(), range = document.createRange();
                range.selectNodeContents(node);
                return { selector, text: node.textContent, visible: node.checkVisibility(), clipped: node.checkVisibility()
                    && [...range.getClientRects()].some(box => box.width && (box.left < rect.left - 1 || box.right > rect.right + 1)),
                    width: rect.width, height: rect.height };
            }) };
    });
    assert.ok(geometry.overflow <= 1, name + ": page overflow");
    assert.ok(geometry.facts.every(item => !item.clipped), name + ": clipped metadata");
    facts.push({ name, ...geometry });
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, name + ".png"), fullPage: false });
    if (name.endsWith("-fresh")) await page.locator("#freshActivity").screenshot({ path: path.join(proof, name + "-detail.png") });
}

test("history metadata keeps independent statuses, live feedback and native operational guards", { timeout: 180000 }, async t => {
    const app = await setup(t), { page } = app, facts = [];
    await revealStoredRefresh(page);
    await navigateMain(page, "collection-status");
    const checkControl = await page.locator("#checkActivity").elementHandle();
    await capture(page, "idle-source", facts);
    const release = app.pending();
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "checking");
    await expect(page.locator("#checkActivity")).toBeDisabled();
    await capture(page, "pending", facts);
    release();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "partial");
    await ready(page);
    const expected = ["2 unavailable", "1 with limits", "3 still reading", "1 awaiting a saved entry", "2 beyond the discovery limit", "2 not checked this cycle"];
    for (const label of expected) await expect(page.locator("#freshIssues")).toContainText(label);
    const visibleSummary = await page.locator("#freshIssues").textContent();
    await expect(page.locator("#freshCoverageAnnouncement")).toHaveText(visibleSummary);
    await expect(page.locator("#freshResult [role=status]")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#freshResult [role=status]")).toHaveAttribute("aria-atomic", "true");
    await page.locator("#freshHelp > summary").click();
    await expect(page.locator("#freshCheckDetails")).toContainText("Missing history is not a Work IQ service error.");
    await expect(page.locator("#freshCoverageDetails")).toContainText("other limits and pending counts may overlap");
    await expect(page.locator("#freshCheckDetails")).toContainText("repeating the check does not remove that limit");
    await page.locator("#freshHelp > summary").click();
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [820, 100], [390, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.locator("#freshActivity").scrollIntoViewIfNeeded();
        await capture(page, `${theme}-${width}-${scale}-fresh`, facts);
        await navigateMain(page, "collection-status"); await expect(page.locator("#collectionIssues")).toBeVisible();
        await page.locator("#collectionIssueCounts").scrollIntoViewIfNeeded();
        await capture(page, `${theme}-${width}-${scale}-issues`, facts);
        await expect(page.locator("#collectionIssueCounts")).toContainText("2 unavailable");
        await expect(page.locator("#collectionIssueCounts")).toContainText("1 limited");
        assert.match(await page.locator("#collectionIssueCounts").innerText(), /2 unavailable\s+1 limited/);
        await navigateMain(page, "collection-status");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    assert.equal(await checkControl.evaluate(node => node === document.getElementById("checkActivity")), true);
    const cases = [
        { name: "all-unavailable", coverage: { eligible: 12, readable: 0, unavailable: 12, limited: 0, pending: 0, affected: 12, groups: { missing: 12 } },
            receipt: { sourcesChecked: 12, pendingSources: 0, partialSources: 0, skippedSources: 0 } },
        { name: "only-limited", coverage: { eligible: 12, readable: 12, unavailable: 0, limited: 4, pending: 0, affected: 4, groups: { context: 4 } },
            receipt: { sourcesChecked: 12, pendingSources: 0, partialSources: 0, skippedSources: 0 } },
        { name: "complete", coverage: { eligible: 12, readable: 12, unavailable: 0, limited: 0, pending: 0, affected: 0, groups: {} },
            receipt: { outcome: "complete", sourcesChecked: 12, pendingSources: 0, partialSources: 0, skippedSources: 0 } },
        { name: "unknown-coverage", coverage: undefined,
            receipt: { sourcesChecked: 12, pendingSources: 0, partialSources: 0, skippedSources: 0 } },
    ];
    for (const scenario of cases) {
        app.set(scenario);
        await page.locator("#checkActivity").click();
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", scenario.name === "complete" ? "complete" : "partial");
        await ready(page);
        await navigateMain(page, "collection-status");
        if (scenario.name === "complete" || !scenario.coverage) await expect(page.locator("#collectionIssueCounts")).toBeHidden();
        else {
            await expect(page.locator("#collectionIssueCounts")).toContainText(`${scenario.coverage.unavailable} unavailable`);
            await expect(page.locator("#collectionIssueCounts")).toContainText(`${scenario.coverage.limited} limited`);
        }
        await expect(page.locator("#collectionIssues")).toHaveAttribute("data-severity", scenario.name === "all-unavailable" ? "error" : "normal");
        await capture(page, scenario.name, facts);
        await navigateMain(page, "collection-status");
    }
    app.set({ coverage: cases[1].coverage, fail: true });
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "error");
    await expect(page.locator("#freshStatus")).toHaveAttribute("data-severity", "error");
    const checks = app.checks();
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    assert.equal(app.checks(), checks, "A stored recovery cannot repeat the source check.");
    await expect(page.locator("#freshContextMessage")).toContainText("local history was not checked again");
    await navigateMain(page, "settings");
    await selectActivityOption(page, "collectionWindow", "7");
    const draft = await page.locator("#collectionWindow").elementHandle();
    await page.waitForTimeout(5500);
    assert.equal(await draft.evaluate(node => node === document.getElementById("collectionWindow") && node.value === "7"), true);
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await expect(page.locator("#cancelPreferences")).toBeEnabled();
    assert.equal(app.requests.some(request => ["/api/collection/configure", "/api/collection/enabled"].includes(request.path)), false);
    if (proof) await writeFile(path.join(proof, "facts.json"), JSON.stringify(facts, null, 2));

    // End-of-test assertions keep the initial red run's native before captures.
    await expect(page.locator("#freshSourceSettings,#activityUpdateToggle")).toHaveCount(0);
    assert.equal(visibleSummary, "Chat history: " + expected.join(", ") + ".");
    await expect(page.locator("#collectionIssueCounts .history-status-count")).toHaveCount(2);
    await page.locator("#cancelPreferences").click();
    app.set({ coverage: undefined, approved: false });
    await page.reload(); await ready(page); await navigateMain(page, "analyze"); await revealStoredRefresh(page);
    await expect(page.locator("#checkActivity")).toHaveAccessibleName("Read stored activity");
    const beforeStoredRead = app.checks();
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    assert.equal(app.checks(), beforeStoredRead, "An unapproved source only permits stored reads.");
    await expect(page.locator("#collectionIssueCounts")).toBeEmpty();
});
