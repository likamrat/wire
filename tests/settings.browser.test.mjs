import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { navigateMain, navigateSettings, selectActivityOption, chooseTheme, openActivitySessions, openSourceEditor } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_SETTINGS_PROOFS;
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, approved = false, sourceName = "source-a") {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-settings-synthetic-"));
    const databases = [];
    async function source(name) {
        const dir = path.join(root, name), sessionRoot = path.join(dir, "session-state"), appDbPath = path.join(dir, "data.db");
        await mkdir(sessionRoot, { recursive: true });
        const db = new DatabaseSync(appDbPath);
        databases.push(db);
        db.exec(`PRAGMA user_version=156;
            CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
            CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
            CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
        const id = randomUUID(), at = new Date().toISOString();
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, "Synthetic settings session", "general_chat", null, "local");
        await mkdir(path.join(sessionRoot, id));
        await writeFile(path.join(sessionRoot, id, "events.jsonl"), [
            { type: "session.start", data: { sessionId: id, version: 1 } },
            { type: "user.message", data: { content: "SYNTHETIC_LOCAL_ORIGINAL settings permission is not export permission." } },
            { type: "tool.execution_start", data: { toolName: "workiq-fetch", toolCallId: id, arguments: { entityUrls: ["/me/messages"] } } },
            { type: "tool.execution_complete", data: { toolCallId: id, success: true } },
        ].map(event => JSON.stringify({ ...event, id: randomUUID(), timestamp: at }) + "\n").join(""));
        return { appDbPath, sessionRoot, db };
    }
    const a = await source(sourceName), b = await source("source-b");
    const context = { dataDir: path.join(root, "private") };
    const controller = createExportController(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const config = { appDbPath: a.appDbPath, sessionRoot: a.sessionRoot, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 };
    if (approved) await runtime.collector.configure(config);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce", hasTouch: true });
    page.setDefaultTimeout(10000);
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push({ path: new URL(request.url()).pathname, data: request.postDataJSON() }); });
    t.after(async () => { await browser.close(); await runtime.close(); for (const db of databases) db.close(); await rm(root, { recursive: true, force: true }); assert.deepEqual(errors, []); });
    return { page, browser, runtime, controller, context, a, b, config, posts };
}
async function saved(page, text) {
    await page.waitForFunction(expected => document.querySelector("#settingsMessage").textContent.startsWith(expected)
        && !document.querySelector("#collectionCadence").disabled, text);
}
async function screenshot(page, name) {
    if (!proofs) return;
    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proofs, name), fullPage: true });
}

test("deliberate setup, existing approval, paused preference save and cancelled/reapproved source changes", { timeout: 90000 }, async t => {
    const { page, runtime, context, a, b, posts } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    assert.equal(await page.locator("#collectionStatus").textContent(), "Not connected");
    assert.equal(await page.locator("#collectionForm").isVisible(), false);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false);
    assert.equal(await page.locator("#checkActivity").innerText(), "Refresh");
    await page.locator("#freshHelp > summary").click();
    assert.equal(await page.locator("#freshSourceSetup").isVisible(), true);
    await page.locator("#freshHelp > summary").click();
    assert.equal((await runtime.collector.status()).config, null);
    await page.locator('nav [data-nav=settings]').focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator("#pageTitle").innerText(), "Settings");
    assert.equal(await page.locator("#connectionTitle").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('nav [data-nav=settings]').getAttribute("aria-current"), "page");
    assert.equal(await page.locator('nav [data-nav=settings] [data-fluent-icon=settings_24_regular]').count(), 1);
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    await page.locator("#reviewSource").click();
    await page.locator("#sourceDatabase").fill(a.appDbPath);
    await page.locator("#sourceSessions").fill(a.sessionRoot);
    await page.keyboard.press("Enter");
    assert.equal(posts.filter(row => row.path === "/api/collection/configure").length, 0, "Typing Enter in a path is not approval");
    await selectActivityOption(page, "collectionWindow", "7");
    await selectActivityOption(page, "collectionCadence", "15");
    assert.match(await page.locator("#approvalScope").innerText(), /7 days.*15 seconds/);
    await navigateSettings(page, "connection");
    await page.locator("#connectCollection").evaluate(node => { node.click(); node.click(); });
    await saved(page, "Source approved.");
    assert.equal(posts.filter(row => row.path === "/api/collection/configure").length, 1, "Duplicate click cannot repeat approval");
    let status = await runtime.collector.status();
    assert.equal(status.config.approved, true);
    assert.equal(status.config.enabled, true);
    assert.equal(status.config.windowDays, 7);
    assert.equal(status.config.pollSeconds, 15);
    assert.equal(await page.locator("#connectionStatus").innerText(), "Collection on");
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    assert.equal(await page.locator("#connectCollection").isVisible(), false);
    assert.equal(await page.locator("#approveCollection").count(), 0);
    assert.equal(await page.locator("#connectionApproval").innerText(), "Approved");
    const before = await loadBoardState(context);
    const originals = await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile));
    await page.locator("#pauseCollection").click(); await saved(page, "Collection paused.");
    await selectActivityOption(page, "collectionWindow", "30");
    await selectActivityOption(page, "collectionCadence", "60");
    await page.locator("#saveCollection").click(); await saved(page, "Preferences saved.");
    status = await runtime.collector.status();
    assert.equal(status.config.enabled, false);
    assert.equal(status.config.pollSeconds, 60);
    assert.equal(status.config.appDbPath, a.appDbPath);
    assert.equal(posts.filter(row => row.path === "/api/collection/configure").at(-1).data.approved, true, "Full writes keep the backend's explicit approval contract");
    await navigateSettings(page, "connection");
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    assert.match(await page.locator("#sourceChangeImpact").innerText(), /stays paused/);
    await page.locator("#cancelSource").click();
    assert.equal((await runtime.collector.status()).config.appDbPath, a.appDbPath);
    assert.equal(posts.filter(row => row.path === "/api/collection/configure").length, 2);
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    assert.equal(await page.locator("#connectCollection").innerText(), "Approve and switch source");
    await page.locator("#connectCollection").click(); await saved(page, "Source approved.");
    status = await runtime.collector.status();
    assert.equal(status.config.sessionRoot, b.sessionRoot);
    assert.equal(status.config.enabled, false);
    const after = await loadBoardState(context);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.exports, []);
    assert.equal(after.pseudonymKey, before.pseudonymKey);
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", before.evidenceFile)), originals);
    assert.ok(!posts.some(row => ["/api/privacy-review", "/api/export", "/api/record", "/api/move"].includes(row.path)));
});

test("drafts retain exact inputs, focus and scroll through polling, routes and Back/Forward", { timeout: 60000 }, async t => {
    const { page, runtime, a, b, posts } = await setup(t, true);
    await page.goto(runtime.url + "#settings"); await ready(page);
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    await page.locator("#sourceSessions").focus();
    const input = await page.locator("#sourceSessions").elementHandle();
    const scroll = await page.evaluate(() => scrollY);
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    assert.equal(await input.evaluate(node => node === document.activeElement && node.isConnected), true);
    assert.equal(await page.locator("#sourceSessions").inputValue(), b.sessionRoot);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scroll) < 2);
    await navigateMain(page, "home");
    assert.equal(await page.locator("#settingsDraftNotice").isVisible(), true);
    assert.equal(await page.locator("#collectionForm").isVisible(), false);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#sourceSessions").inputValue(), b.sessionRoot);
    assert.equal(await page.locator("#sourceEditor").isVisible(), true);
    await page.goForward(); await ready(page);
    assert.equal(await page.locator("#pageTitle").innerText(), "Analyze");
    await page.locator("#settingsDraftNotice a").click();
    await page.locator("#cancelSource").click();
    assert.equal(await page.locator("#sourceSessions").inputValue(), a.sessionRoot);
    assert.equal((await runtime.collector.status()).config.sessionRoot, a.sessionRoot);
    assert.equal(posts.filter(row => /collection\/(configure|enabled|now)/.test(row.path)).length, 0);
    await page.goto(runtime.url + "#settings?issues=1");
    await page.getByText("No history gaps reported", { exact: true }).waitFor();
    assert.equal(await page.locator("#collectionIssuesTitle").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.locator("#navigationToggle").tap();
    assert.equal(await page.locator("#navigationDrawer").getAttribute("open"), "");
    assert.equal(await page.locator('nav [data-nav=settings]').isVisible(), true);
    await page.locator('nav [data-nav=analyze]').tap();
    await ready(page);
    assert.equal(await page.locator("#navigationDrawer").getAttribute("open"), null);
    assert.equal(await page.locator("#pageTitle").innerText(), "Analyze");
    assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true,
        "Returning to the existing Analyze reading position restores the drawer trigger rather than a new Activity heading");
});

test("invalid writes, concurrent settings and uncertain responses remain explicit without replay", { timeout: 90000 }, async t => {
    const { page, runtime, a, b, config, posts } = await setup(t, true);
    await page.goto(runtime.url + "#settings"); await ready(page);
    const original = (await runtime.collector.status()).config;
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill("relative-data.db");
    await page.locator("#connectCollection").click();
    await page.locator("#reloadSettings").waitFor();
    assert.match(await page.locator("#settingsMessage").innerText(), /absolute data.db path.*No success is assumed/s);
    assert.deepEqual((await runtime.collector.status()).config, original);
    assert.equal(await page.locator("#sourceDatabase").inputValue(), "relative-data.db");
    assert.equal(await page.locator("#connectCollection").isDisabled(), true);
    await page.locator("#reloadSettings").click();
    await page.locator("#reloadSettings").waitFor({ state: "hidden" });
    await page.locator("#cancelSource").click();
    await selectActivityOption(page, "collectionCadence", "15");
    // A separate, synthetic panel wins the write before this panel receives a poll.
    await runtime.collector.configure({ ...config, pollSeconds: 30, expectedConfigVersion: (await runtime.collector.status()).configVersion });
    await page.locator("#saveCollection").click();
    await page.locator("#reloadSettings").waitFor();
    assert.match(await page.locator("#settingsMessage").innerText(), /changed in another panel/);
    assert.equal((await runtime.collector.status()).config.pollSeconds, 30);
    assert.equal(await page.locator("#collectionCadence").inputValue(), "15");
    await page.locator("#reloadSettings").click();
    await page.locator("#reloadSettings").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#saveCollection").isDisabled(), true);
    await page.locator("#cancelPreferences").click();
    assert.equal(await page.locator("#collectionCadence").inputValue(), "30");
    await page.route("**/api/collection/configure", async route => { await route.fetch(); await route.abort("failed"); });
    await navigateSettings(page, "connection");
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    const count = posts.filter(row => row.path === "/api/collection/configure").length;
    await page.locator("#connectCollection").click();
    await page.locator("#reloadSettings").waitFor();
    assert.equal((await runtime.collector.status()).config.appDbPath, b.appDbPath);
    assert.equal(posts.filter(row => row.path === "/api/collection/configure").length, count + 1);
    assert.match(await page.locator("#settingsMessage").innerText(), /No action was replayed/);
    await page.locator("#reloadSettings").click();
    await page.locator("#reloadSettings").waitFor({ state: "hidden" });
    assert.match(await page.locator("#settingsDraftStatus").innerText(), /changed in another panel/);
    await page.locator("#cancelSource").click();
    assert.equal(await page.locator("#approvedDatabase").textContent(), b.appDbPath);
    assert.notEqual(await page.locator("#approvedDatabase").textContent(), a.appDbPath);
});

test("Settings cannot grant report review or revive an invalidated frozen preview", { timeout: 60000 }, async t => {
    const { page, runtime, context, controller, posts } = await setup(t, true);
    await page.goto(runtime.url + "#reports"); await ready(page);
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator("#exportBtn").click();
    await page.locator(".attestation input[data-review-control]").waitFor();
    await navigateMain(page, "settings");
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#saveCollection").click(); await saved(page, "Preferences saved.");
    await page.goBack(); await ready(page);
    assert.equal(await page.locator(".attestation input[data-review-control]").isDisabled(), true);
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    assert.equal(await page.locator("#reportStage3").isVisible(), false);
    assert.match(await page.locator("#reportJourneyError").innerText(), /Collection settings changed.*Prepare a fresh report preview; source approval is not disclosure review/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.ok(!posts.some(row => ["/api/privacy-review", "/api/export"].includes(row.path)));
    assert.ok(posts.some(row => row.path === "/api/cancel-preview"));
    assert.ok(controller);
});

test("minimal settings and Home stay readable in light/dark at 375/820/1200 and enlarged text", { timeout: 90000 }, async t => {
    const { page, runtime, posts } = await setup(t, true);
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(runtime.url); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 960 }); await chooseTheme(page, theme);
        await page.waitForFunction(() => innerWidth < 700
            ? document.querySelector("#navigationToggle").checkVisibility()
            : document.querySelector('nav [data-nav=analyze]').checkVisibility());
        await navigateMain(page, "home");
        assert.equal(await page.locator("#collectionForm").isVisible(), false);
        assert.equal(await page.locator("#collectNow").isVisible(), false);
        assert.equal(await page.locator("#pauseCollection").isVisible(), false);
        assert.equal(await page.locator("#sourceDatabase").isVisible(), false);
        await screenshot(page, `home-${theme}-${width}.png`);
        await navigateMain(page, "settings");
        assert.equal(await page.locator("#filters").isVisible(), false);
        assert.equal(await page.locator("#sourceEditor").isVisible(), false);
        assert.equal(await page.locator("#collectionSetup").getAttribute("open"), null);
        assert.equal(await page.locator("#settingsView").evaluate(node => getComputedStyle(node).fontSize), "14px", "Settings adopts the verified reference body role");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        for (const size of await page.locator("#settingsView button").evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).map(n => n.getBoundingClientRect().height))) assert.ok(size >= 44);
        await screenshot(page, `settings-${theme}-${width}.png`);
        await openSourceEditor(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await screenshot(page, `source-review-${theme}-${width}.png`);
        await page.locator("#cancelSource").click();
    }
    await page.setViewportSize({ width: 375, height: 960 });
    await page.addStyleTag({ content: "html{font-size:200%}" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await openSourceEditor(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(posts.filter(row => /collection\/(configure|enabled|now)/.test(row.path)).length, 0);
});

test("source presentation has one path pair with equal field geometry through focus and enlarged text", { timeout: 120000 }, async t => {
    const { page, runtime, posts } = await setup(t, true, "source-a-\u00e9\u4f8b-space  pair-" + "long-folder-name-".repeat(2));
    const proofDir = process.env.WORKIQ_SOURCE_PROOFS;
    if (proofDir) await mkdir(proofDir, { recursive: true });
    await page.goto(runtime.url + "#settings?section=connection&setting=source-paths"); await ready(page);
    const measurements = [];
    async function capture(name) {
        if (!proofDir) return;
        const viewport = page.viewportSize();
        await page.setViewportSize({ ...viewport, height: await page.evaluate(() => document.documentElement.scrollHeight) });
        await page.evaluate(() => scrollTo(0, 0));
        await page.locator('[data-settings-section="connection"]').screenshot({ path: path.join(proofDir, name) });
        await page.setViewportSize(viewport);
    }
    async function measure() {
        await page.evaluate(() => document.fonts.ready);
        return page.locator("#sourceEditor input").evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
            return { id: node.id, left: rect.left, right: rect.right, height: rect.height,
                padding: css.padding, radius: css.borderRadius, border: css.borderWidth,
                boxSizing: css.boxSizing, fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, lineHeight: css.lineHeight,
                outline: css.outlineStyle, outlineWidth: css.outlineWidth, outlineOffset: css.outlineOffset,
                outlineColor: css.outlineColor, background: css.backgroundColor, color: css.color,
                focusVisible: node.matches(":focus-visible") };
        }));
    }
    const geometry = row => Object.fromEntries(["left", "right", "height", "padding", "radius", "border", "boxSizing", "fontFamily", "fontSize", "fontWeight", "lineHeight"].map(key => [key, row[key]]));
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const size of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
        await page.evaluate(() => document.fonts.ready);
        // Capture the old screenshot's expanded state as well as the new plain values.
        await page.locator("#approvedSourceDetails").evaluate(node => { if (node.tagName === "DETAILS") node.open = true; });
        await page.locator("#approvedSourceDetails").scrollIntoViewIfNeeded();
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
        const readValues = await page.locator(".settings-paths dd").evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(node);
            const lines = [...range.getClientRects()];
            return { id: node.id, lines: lines.length, fullValuePainted: lines.every(line =>
                line.left >= box.left - 1 && line.right <= box.right + 1 && line.top >= box.top - 1 && line.bottom <= box.bottom + 1),
                noHorizontalClipping: node.scrollWidth <= node.clientWidth, whitespacePreserved: node.innerText === node.textContent };
        }));
        assert.ok(readValues.every(row => row.fullValuePainted && row.noHorizontalClipping && row.whitespacePreserved), `Full read paths are painted without hidden horizontal overflow: ${theme}/${width}/${size}`);
        await capture(`source-read-${theme}-${width}-${size}.png`);
        await openSourceEditor(page);
        const databaseFocus = await measure();
        await capture(`source-focus-database-${theme}-${width}-${size}.png`);
        await page.locator("#sourceSessions").focus();
        const historyFocus = await measure();
        await capture(`source-focus-history-${theme}-${width}-${size}.png`);
        await page.evaluate(() => document.activeElement.blur());
        const normal = await measure();
        const duplicated = await page.locator("#approvedDatabase").isVisible();
        measurements.push({ theme, width, size, duplicated, readValues, normal, databaseFocus, historyFocus });
        await capture(`source-edit-${theme}-${width}-${size}.png`);
        assert.deepEqual(geometry(normal[0]), geometry(normal[1]));
        for (const row of [...databaseFocus, ...historyFocus]) assert.deepEqual(geometry(row), geometry(normal[0]));
        assert.equal(databaseFocus[0].focusVisible, true);
        assert.equal(historyFocus[1].focusVisible, true);
        assert.ok(contrast(databaseFocus[0].outlineColor, databaseFocus[0].background) >= 3);
        for (const row of normal) {
            assert.ok(row.height >= 44);
            assert.equal(row.fontSize, size === 200 ? "28px" : "14px", "Source fields use the shared Fluent control role");
            assert.ok(contrast(row.color, row.background) >= 4.5);
            assert.notEqual(row.radius, "999px", "Text fields are not action pills");
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator("#cancelSource").click();
    }
    if (proofDir) await writeFile(path.join(proofDir, "source-geometry.json"), JSON.stringify(measurements, null, 2));
    assert.ok(measurements.every(row => !row.duplicated), "Read-only approved paths must not be visible beside editable draft paths");
    assert.equal(posts.filter(row => /collection\/(configure|enabled|now)/.test(row.path)).length, 0);
});

test("source read/edit targets retain drafts across search, categories, time zone and history without granting permission", { timeout: 60000 }, async t => {
    const { page, runtime, context, a, b, posts } = await setup(t, true);
    const configFile = path.join(context.dataDir, "collector", "config.json");
    const original = await readFile(configFile);
    await page.addInitScript(() => {
        window.clipboardWrites = 0;
        Object.defineProperty(navigator, "clipboard", { value: { writeText() { window.clipboardWrites++; return Promise.resolve(); } } });
    });
    await page.goto(runtime.url + "#settings?section=connection&setting=source-paths"); await ready(page);
    assert.equal(await page.locator("#approvedSourceTitle").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    assert.equal(await page.locator("#approvedDatabase").textContent(), a.appDbPath);
    for (const id of ["approvedDatabase", "approvedSessions"]) {
        assert.equal(await page.locator("#" + id).evaluate(node => getComputedStyle(node).borderWidth), "0px");
    }
    await openSourceEditor(page);
    assert.equal(await page.getByRole("textbox", { name: "Copilot metadata database", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#editSource").isVisible(), false);
    assert.equal(await page.locator("#approvedDatabase").isVisible(), false);
    assert.equal(await page.locator("#connectionApproval").isVisible(), true);
    assert.equal(await page.locator("#connectCollection").isDisabled(), true);
    assert.match(await page.locator("#sourceChangeImpact").innerText(), /Paths unchanged/);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("textbox", { name: "Chat history folder", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    await page.keyboard.press("Enter");
    const field = await page.locator("#sourceDatabase").elementHandle();
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionCadence", "15");
    await navigateSettings(page, "display");
    await selectActivityOption(page, "displayTimeZone", "UTC"); await ready(page);
    for (const query of ["source", "path", "change", "permission"]) {
        await page.locator("#settingsSearch").fill(query);
        assert.ok(await page.locator('#settingsSearchResults a[data-setting="source"], #settingsSearchResults a[data-setting="source-paths"]').count() > 0);
        await page.locator('#settingsSearchResults a[data-setting="source"], #settingsSearchResults a[data-setting="source-paths"]').first().click();
        assert.equal(await field.evaluate(node => node.isConnected && node === document.activeElement), true);
        assert.equal(await page.locator("#sourceDatabase").inputValue(), b.appDbPath);
        assert.equal(await page.locator("#collectionCadence").inputValue(), "15");
        assert.equal(await page.locator("#approvedSourceDetails").isVisible(), false);
    }
    await page.evaluate(() => { location.hash = "#settings?section=connection&setting=source-paths"; });
    await page.waitForFunction(() => document.activeElement?.id === "sourceDatabase");
    await navigateMain(page, "activity"); await ready(page);
    await openActivitySessions(page);
    await page.locator("#activityList .request-link").first().click(); await ready(page);
    assert.equal(await page.locator("#settingsDraftNotice").isVisible(), true);
    assert.equal(posts.filter(row => row.path === "/api/collection/configure").length, 0);
    await page.locator("#settingsDraftNotice a").click();
    assert.equal(await page.locator("#sourceDatabase").inputValue(), b.appDbPath);
    assert.equal(await page.locator("#sourceSessions").inputValue(), b.sessionRoot);
    assert.equal(await page.locator("#collectionCadence").inputValue(), "15");
    await navigateMain(page, "home"); await page.goBack(); await ready(page);
    assert.equal(await page.locator("#sourceEditor").isVisible(), true);
    await page.goForward(); await ready(page);
    await page.locator("#settingsDraftNotice a").click();
    assert.equal(await page.locator("#sourceSessions").inputValue(), b.sessionRoot);
    assert.deepEqual(await readFile(configFile), original);
    await page.locator("#cancelSource").click();
    assert.equal(await page.locator("#editSource").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#approvedDatabase").textContent(), a.appDbPath);
    assert.equal(await page.locator("#sourceDatabase").inputValue(), a.appDbPath);
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    await openSourceEditor(page);
    await page.locator("#sourceSessions").focus();
    assert.equal(await page.locator("#sourceDatabase").evaluate(node => getComputedStyle(node).outlineStyle), "none", "Cancelled search highlights must not imitate a second focus ring");
    await page.locator("#cancelSource").click();
    assert.equal(await page.evaluate(() => {
        const ids = [...document.querySelectorAll("[id]")].map(node => node.id);
        return ids.length === new Set(ids).size;
    }), true);
    assert.equal(await page.evaluate(() => window.clipboardWrites), 0);
    assert.equal(posts.filter(row => /collection\/(configure|enabled|now)|privacy-review|export|record/.test(row.path)).length, 0);
    assert.deepEqual(await readFile(configFile), original);
});

test("pending and rejected source replacements keep approved bytes, paused state and error-linked fields", { timeout: 60000 }, async t => {
    const { page, runtime, context, a, b, posts } = await setup(t, true);
    const proofDir = process.env.WORKIQ_SOURCE_PROOFS, stateMeasurements = [];
    async function stateMatrix(state) {
        const rows = [];
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const size of [100, 200]) {
            await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
            await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
            await page.evaluate(() => document.fonts.ready);
            await page.waitForFunction(() => matchMedia("(max-width:699px)").matches ||
                Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) - document.querySelector("#sidebar").getBoundingClientRect().width) < .01);
            const fields = await page.locator("#sourceEditor input").evaluateAll(nodes => nodes.map(node => {
                const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
                return [rect.left, rect.right, rect.height, css.borderRadius, css.padding, css.fontFamily, css.fontSize, css.fontWeight, css.lineHeight, css.borderWidth];
            }));
            assert.deepEqual(fields[0], fields[1], `${state}: equal field geometry at ${theme}/${width}/${size}`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            rows.push({ theme, width, size, fields });
            if (proofDir && [375, 1200].includes(width)) {
                await mkdir(proofDir, { recursive: true });
                await page.keyboard.press("Escape"); await page.mouse.move(0, 0);
                await page.setViewportSize({ width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
                await page.evaluate(() => scrollTo(0, 0));
                await page.locator(".settings-content").screenshot({ path: path.join(proofDir, `source-${state}-${theme}-${width}-${size}.png`) });
            }
        }
        stateMeasurements.push({ state, rows });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1200, height: 900 }); await chooseTheme(page, "light");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) - document.querySelector("#sidebar").getBoundingClientRect().width) < .01);
        return rows;
    }
    await runtime.collector.setEnabled(false);
    const configFile = path.join(context.dataDir, "collector", "config.json"), original = await readFile(configFile);
    const originalStatus = await runtime.collector.status(), before = await loadBoardState(context);
    b.db.exec("PRAGMA user_version=999; ALTER TABLE sessions RENAME COLUMN execution_location TO removed_location");
    await page.goto(runtime.url + "#settings"); await ready(page);
    const invalid = [
        { database: "relative-data.db", sessions: a.sessionRoot, error: /absolute data.db path/ },
        { database: a.appDbPath, sessions: path.join(path.dirname(b.sessionRoot), "missing", "session-state"), error: /directory could not be opened/ },
        { database: path.join(path.dirname(b.appDbPath), "missing", "data.db"), sessions: b.sessionRoot, error: /metadata could not be read/ },
        { database: b.appDbPath, sessions: b.sessionRoot, error: /Unsupported sessions mapping.*999/ },
    ];
    let release;
    t.after(() => release?.());
    for (const [index, entry] of invalid.entries()) {
        await openSourceEditor(page);
        await page.locator("#sourceDatabase").fill(entry.database);
        await page.locator("#sourceSessions").fill(entry.sessions);
        const geometry = () => page.locator("#sourceEditor input").evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
            return [rect.left, rect.right, rect.height, css.borderRadius, css.padding, css.fontFamily, css.fontSize, css.fontWeight, css.lineHeight, css.borderWidth];
        }));
        const normal = await geometry();
        assert.deepEqual(normal[0], normal[1]);
        const normalMatrix = index === 0 ? await stateMatrix("ready-draft") : null;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route("**/api/collection/configure", async route => { await gate; await route.continue(); });
        await page.locator("#connectCollection").click();
        await page.waitForFunction(() => document.querySelector("#sourceDatabase").disabled);
        assert.equal(await page.locator("#cancelSource").isDisabled(), true);
        assert.equal(await page.locator("#connectionApproval").isVisible(), true);
        assert.equal(await page.locator("#approvedSourceDetails").isVisible(), false);
        assert.deepEqual(await geometry(), normal, "Pending disables both fields without changing their shape");
        if (normalMatrix) assert.deepEqual(await stateMatrix("pending"), normalMatrix);
        assert.deepEqual(await readFile(configFile), original);
        assert.equal((await runtime.collector.status()).configVersion, originalStatus.configVersion);
        release();
        await page.locator("#reloadSettings").waitFor();
        await page.unroute("**/api/collection/configure");
        assert.match(await page.locator("#settingsMessage").innerText(), entry.error);
        assert.equal(await page.locator("#settingsMessage").getAttribute("role"), "alert");
        assert.equal(await page.locator("#settingsMessage").evaluate(node => node === document.activeElement), true);
        assert.deepEqual(await geometry(), normal, "Rejected validation keeps both field geometries");
        if (normalMatrix) assert.deepEqual(await stateMatrix("error"), normalMatrix);
        for (const id of ["sourceDatabase", "sourceSessions"]) {
            assert.match(await page.locator("#" + id).getAttribute("aria-describedby"), /settingsMessage/);
        }
        assert.deepEqual(await readFile(configFile), original);
        const status = await runtime.collector.status();
        assert.equal(status.configVersion, originalStatus.configVersion);
        assert.equal(status.config.enabled, false);
        assert.equal(status.config.approved, true);
        assert.equal(posts.filter(row => row.path === "/api/collection/configure").length, index + 1);
        await page.locator("#reloadSettings").click();
        await page.locator("#reloadSettings").waitFor({ state: "hidden" });
        await page.locator("#cancelSource").click();
    }
    assert.deepEqual(await loadBoardState(context), before);
    b.db.exec("PRAGMA user_version=156; ALTER TABLE sessions RENAME COLUMN removed_location TO execution_location");
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    await runtime.collector.configure({ appDbPath: a.appDbPath, sessionRoot: a.sessionRoot,
        approved: true, enabled: false, windowDays: 7, pollSeconds: 30, expectedConfigVersion: originalStatus.configVersion });
    await page.waitForFunction(() => document.querySelector("#sourceChangeImpact").textContent.includes("changed in another panel"));
    assert.equal(await page.locator("#sourceDatabase").inputValue(), b.appDbPath);
    assert.equal(await page.locator("#connectCollection").isDisabled(), true);
    assert.equal(await page.locator("#connectionApproval").isVisible(), true);
    assert.equal(await page.locator("#approvedSourceDetails").isVisible(), false);
    await page.locator("#cancelSource").click();
    assert.equal(await page.locator("#collectionCadence").inputValue(), "30");
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill(b.appDbPath);
    await page.locator("#sourceSessions").fill(b.sessionRoot);
    await page.locator("#connectCollection").click(); await saved(page, "Source approved.");
    const switched = await runtime.collector.status();
    assert.equal(switched.config.appDbPath, b.appDbPath);
    assert.equal(switched.config.enabled, false);
    assert.equal(switched.config.windowDays, 7);
    assert.equal(switched.config.pollSeconds, 30);
    assert.notEqual(switched.configVersion, originalStatus.configVersion);
    assert.equal(await page.locator("#approvedDatabase").textContent(), b.appDbPath);
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
    assert.equal(await page.locator("#settingsMessage").evaluate(node => node === document.activeElement), true);
    assert.ok(!posts.some(row => /privacy-review|export|record|collection\/(enabled|now)/.test(row.path)));
    if (proofDir) await writeFile(path.join(proofDir, "source-state-geometry.json"), JSON.stringify(stateMeasurements, null, 2));
});
