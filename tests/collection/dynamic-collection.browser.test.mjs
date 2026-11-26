import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { selectActivityOption, navigateMain, revealStoredRefresh } from "../support/helpers.mjs";
import { TAIL_LIMITS } from "../../lib/collector-io.mjs";
import { prepareLandingReport } from "../reports/report-journey-helpers.mjs";

test("synthetic UI: Refresh backfills an omitted request into Analyze and Search without losing filters or frozen review", { timeout: 90000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-live-browser-synthetic-"));
    const sessionRoot = path.join(root, "session-state"), appDbPath = path.join(root, "data.db");
    await mkdir(sessionRoot);
    const db = new DatabaseSync(appDbPath);
    db.exec(`PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    const context = { dataDir: path.join(root, "private") };
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    t.after(async () => { await browser.close(); await runtime.close(); db.close(); await rm(root, { recursive: true, force: true }); });
    async function addSession({ omittedPrefix = false } = {}) {
        const id = randomUUID(), timestamp = new Date().toISOString();
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, "Synthetic live session", "general_chat", null, "local");
        await mkdir(path.join(sessionRoot, id));
        const events = [
            { type: "session.start", data: { sessionId: id, version: 1 } },
            { type: "user.message", data: { content: "Synthetic live request; no real workplace data." } },
            { type: "tool.execution_start", data: { toolName: "workiq-fetch", toolCallId: randomUUID(), arguments: { entityUrls: ["/me/messages"] } } },
        ].map(e => ({ ...e, id: randomUUID(), timestamp }));
        const file = path.join(sessionRoot, id, "events.jsonl");
        await writeFile(file, events.map(e => JSON.stringify(e) + "\n").join(""));
        if (omittedPrefix) {
            const handle = await open(file, "a");
            try {
                await handle.writeFile(`{"id":"padding","type":"assistant.message","timestamp":"${timestamp}","data":{"content":"`);
                const padding = Buffer.alloc(1024 ** 2, 120);
                for (let offset = 0; offset < TAIL_LIMITS.initialFileBytes; offset += padding.length) await handle.write(padding);
                await handle.writeFile('"}}\n');
            } finally { await handle.close(); }
        }
        return { id, file };
    }
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Los_Angeles" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await expect(page.locator("#analyzeRefresh")).toBeVisible();
    assert.equal((await loadBoardState(context)).evidence?.length ?? 0, 0);
    await page.locator("#collectionNoticeAction").click();
    await expect(page.locator("#sourceDatabase")).toBeFocused();
    await page.locator("#sourceDatabase").fill(appDbPath);
    await page.locator("#sourceSessions").fill(sessionRoot);
    await page.locator("#connectCollection").click();
    await page.locator("#firstCollectionActivity").click();
    await selectActivityOption(page, "dateFilter", "7");
    await selectActivityOption(page, "serviceFilter", "Mail");
    await page.evaluate(() => { window.dynamicNoReload = "retained"; document.activeElement.blur(); });
    const prefix = await addSession({ omittedPrefix: true });
    const configFile = path.join(context.dataDir, "collector", "config.json"), configBefore = await readFile(configFile);
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/collection/now"));
    await (await revealStoredRefresh(page)).click();
    const response = await refreshed, receipt = await response.json();
    assert.equal(response.status(), 200);
    assert.equal(receipt.check.changes.added, 1);
    assert.equal(receipt.check.sourcesChecked, 1);
    assert.equal(receipt.check.outcome, "partial");
    assert.ok(receipt.metrics.lastBytesRead <= TAIL_LIMITS.cycleBytes);
    assert.equal(receipt.backfill.visitedSources, 1);
    await navigateMain(page, "home");
    await page.waitForFunction(() => document.querySelector("#activityCount").textContent === "1", { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.dynamicNoReload), "retained");
    assert.equal(await page.locator("#dateFilter").inputValue(), "7");
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Mail");
    await page.locator("#wireSearch").fill("workiq-fetch");
    await expect(page.locator('#wireSearchResults button[aria-label^="Open recorded call:"]')).toHaveCount(1, { timeout: 15000 });
    await page.locator('#wireSearchResults button[aria-label^="Open recorded call:"]').click();
    await expect(page).toHaveURL(/\/request\?/);
    await expect(page.getByText("Synthetic live request; no real workplace data.", { exact: true }).first()).toBeVisible();
    if (process.env.WIRE_COLLECTOR_JOURNEY_SCREENSHOT) {
        await page.screenshot({ path: process.env.WIRE_COLLECTOR_JOURNEY_SCREENSHOT, fullPage: true });
    }
    await page.goBack();
    await page.locator("#wireSearch").fill("");
    assert.deepEqual(await readFile(configFile), configBefore);
    const index = JSON.parse(await readFile(path.join(context.dataDir, "collector", "index.json")));
    assert.ok(index.sources[prefix.id].cursor.droppedBytes > 0, "Backfill does not erase the original omission warning");
    t.diagnostic(JSON.stringify({ added: receipt.check.changes.added, sourceChecks: receipt.check.sourcesChecked,
        backfillVisited: receipt.backfill.visitedSources, bytes: receipt.metrics.lastBytesRead,
        originalOmission: index.sources[prefix.id].cursor.droppedBytes, journey: "UI Refresh -> receipt -> Analyze -> Search -> request reader" }));
    await navigateMain(page, "reports");
    const [prepared] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/preview")), prepareLandingReport(page, "all")]);
    const preview = await prepared.json();
    assert.equal(prepared.status(), 200);
    assert.equal(preview.records.length, 1);
    assert.equal(preview.timeContext.timeZone, "America/Los_Angeles");
    const frame = page.frameLocator(".report-frame").locator("body");
    await expect(frame.locator("h1")).toBeVisible();
    const original = await frame.innerText();
    await addSession(); await runtime.collector.collectNow();
    assert.equal((await loadBoardState(context)).evidence.length, 2);
    await expect(page.locator("#reportPreviewActivityNotice")).toBeVisible();
    assert.equal(await frame.innerText(), original);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});
