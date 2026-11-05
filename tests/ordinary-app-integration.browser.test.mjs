import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { createCollector } from "../lib/collector.mjs";
import { createExportController } from "../lib/export.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, navigateMain, navigateSettings, revealStoredRefresh, chooseTheme, openAnalyzeFilters,
    closeAnalyzeFilters } from "./helpers.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { openReportLibrary, chooseReportScope, reportContents, scanReport, openReportComparison, selectAnalyzeRequest } from "./report-journey-helpers.mjs";

async function assertSettingsCategoryNavigation(page, { keyboard = false } = {}) {
    const url = new URL(page.url()); url.hash = "";
    const categories = [
        ["privacy", "dataManagementTitle"], ["display", "displayTitle"],
        ["troubleshooting", "troubleshootingTitle"], ["connection", "connectionTitle"],
    ];
    for (const [category, heading] of categories) {
        if (keyboard) {
            const link = page.locator(`#settingsCategoryNav [data-category=${category}]`);
            if (!await link.isVisible()) await page.locator("#settingsCategorySummary").press("Enter");
            await expect(link).toBeVisible();
            await link.focus();
            await expect(link).toBeFocused();
            await page.keyboard.press("Enter");
        } else await navigateSettings(page, category);
        await expect(page).toHaveURL(url.href + "#settings?section=" + category);
        await expect(page.locator(`[data-settings-section=${category}]`)).toBeVisible();
        await expect(page.locator("[data-settings-section]:visible")).toHaveCount(1);
        await expect(page.locator(`#settingsCategoryNav [data-category=${category}]`)).toHaveAttribute("aria-current", "page");
        await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveCount(1);
        await expect(page.locator("#" + heading)).toBeFocused();
        assert.doesNotMatch(await page.locator("#settingsView").innerText(), /Microsoft\s*365|\bM365\b|\bCowork\b|Microsoft (?:connection|collection|sources|reads|activity)|incubat/i);
    }
}

for (const statusFailure of [false, true]) test(`Copilot-only explicit Refresh admits composite status and publishes a late failed completion without reloading${statusFailure ? " after a failed composite read" : ""}`, { timeout: 60000 }, async t => {
    const cleanups = [], { root, context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    let collector, child, exited, browser, readyTimer;
    t.after(async () => {
        clearTimeout(readyTimer);
        await browser?.close();
        if (child) {
            if (child.connected) child.disconnect();
            const timer = setTimeout(() => child.kill(), 5000);
            try { assert.equal(await exited, 0); }
            finally { clearTimeout(timer); }
        }
        await collector?.close();
        for (const cleanup of cleanups.reverse()) await cleanup();
    });
    const sourceId = randomUUID(), appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const db = new DatabaseSync(appDbPath);
    try {
        db.exec(metadata174Schema);
        db.prepare("INSERT INTO sessions(id,title,session_type,execution_location) VALUES(?,?,?,?)")
            .run(sourceId, "Invented late completion", "chat", "local");
    } finally { db.close(); }
    const file = path.join(sessionRoot, sourceId, "events.jsonl");
    const event = (id, type, data) => ({ id, type, timestamp: new Date(Date.now() - 2000).toISOString(), data });
    const lines = rows => rows.map(row => JSON.stringify(row) + "\n").join("");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, lines([
        event("session", "session.start", { sessionId: sourceId, version: 1 }),
        event("prompt", "user.message", { content: "Inspect the invented late completion." }),
        event("start", "tool.execution_start", { toolName: "workiq-fetch", toolCallId: "late-call",
            arguments: { entityUrls: ["/planner/tasks/invented-task"] } }),
    ]));
    collector = await createCollector(context, { timers: false });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const before = await loadBoardState(context);
    assert.equal(before.evidence[0].toolCalls[0].completionEventId, null);
    const configFile = path.join(context.dataDir, "collector", "config.json"), config = await readFile(configFile);
    await collector.close(); collector = null;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        name !== "NODE_TEST_CONTEXT" && name !== "NODE_OPTIONS" && !name.startsWith("WIRE_")
        && !/^(?:GH|GITHUB|COPILOT)(?:_[A-Z0-9]+)*_TOKEN$/i.test(name)));
    await Promise.all([mkdir(path.join(root, "no-copilot")), mkdir(path.join(root, "no-profile"))]);
    child = fork(new URL("../scripts/start.mjs", import.meta.url), ["--port", "0"], {
        env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: context.dataDir,
            COPILOT_HOME: path.join(root, "no-copilot"), GH_CONFIG_DIR: path.join(root, "no-profile") },
        execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    exited = new Promise(resolve => child.once("exit", resolve));
    let output = "", stderr = "";
    child.stderr.on("data", bytes => { stderr += bytes; });
    const url = await new Promise((resolve, reject) => {
        readyTimer = setTimeout(() => reject(new Error("Ordinary readiness timed out: " + stderr)), 15000);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Ordinary launcher exited: " + stderr)));
        child.stdout.on("data", bytes => {
            output += bytes;
            const ready = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
            if (ready) resolve(ready[1]);
        });
    });
    clearTimeout(readyTimer);
    const origin = new URL(url).origin, errors = [], external = [], checks = [], composites = [];
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url() === origin + "/api/collection/now") checks.push(request); });
    page.on("response", response => {
        if (response.url() === origin + "/api/collection/sources/status" && response.status() === 200) {
            composites.push(response.json());
        }
    });
    let failComposite = false;
    await page.route("**/*", async route => {
        if (statusFailure && route.request().url() === origin + "/api/collection/now") {
            const response = await route.fetch();
            failComposite = true;
            return route.fulfill({ response });
        }
        if (failComposite && route.request().url() === origin + "/api/collection/sources/status") {
            failComposite = false;
            return route.fulfill({ status: 503, contentType: "application/json",
                body: JSON.stringify({ error: "Invented composite status read failure." }) });
        }
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    await page.goto(url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityList .request-card-open")).toContainText(/no result recorded/i);
    await selectAnalyzeRequest(page, page.locator("#activityList .activity-card"));
    await navigateMain(page, "reports");
    await chooseReportScope(page, "selected");
    await reportContents(page);
    await page.locator("#reportTitle").fill("Reviewed late completion");
    await page.locator("[name=promptMode][value=none]").check();
    const selection = await page.locator("#previewSelectionSummary").textContent();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    const message = "The invented item cannot be edited.";
    await appendFile(file, lines([event("completion", "tool.execution_complete", {
        toolCallId: "late-call", success: false, error: { code: "AccessDenied", message },
    })]));
    await navigateMain(page, "settings");
    await expect(page.locator("#settingsView")).toBeVisible();
    await navigateSettings(page, "connection");
    const refresh = page.locator("#checkActivity");
    await expect(refresh).toBeVisible();
    const [response] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + "/api/collection/now"),
        refresh.click(),
    ]);
    assert.equal(response.status(), 200);
    const receipt = await response.json();
    assert.equal(receipt.check.changes.updated, 1);
    const committed = await loadBoardState(context, { readOnly: true });
    assert.equal(committed.evidence[0].toolCalls[0].completionEventId, "completion");
    assert.equal(committed.evidence[0].toolCalls[0].toolSucceeded, false);
    if (statusFailure) {
        await expect(page.locator("#freshStatus")).toHaveText("Check finished; view not updated.");
        await page.getByRole("button", { name: "Read stored activity", exact: true }).click();
    }
    await expect(refresh).toBeEnabled();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#freshStatus")).not.toContainText("view not updated");
    await assertSettingsCategoryNavigation(page);
    await assertSettingsCategoryNavigation(page, { keyboard: true });
    if (!statusFailure) {
        const currentStatus = (await Promise.all(composites)).find(status => status.github.status.revision === committed.revision);
        assert.ok(currentStatus, "Refresh must admit the current Copilot-only composite, not render its raw collection receipt.");
        assert.equal(Object.hasOwn(currentStatus, "microsoft"), false);
    }
    await navigateMain(page, "analyze");
    const card = page.locator("#activityList .request-card-open");
    await expect(card).toContainText(/failed/i);
    await expect(card).not.toContainText(/no result recorded/i);
    await card.click();
    const call = page.locator('[data-tool-call-id="late-call"]');
    if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") {
        await call.locator(".reader-call-toggle").click();
    }
    await expect(call).toContainText(message);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await page.locator("#wireSearch").fill("AccessDenied");
    await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.locator("#requestContent")).toContainText(message);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await page.locator("#wireSearch").fill("");
    await navigateMain(page, "reports");
    await reportContents(page);
    await expect(page.locator("#reportTitle")).toHaveValue("Reviewed late completion");
    await expect(page.locator("[name=promptMode][value=none]")).toBeChecked();
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), selection);
    await page.locator("#reportResultText").check();
    for (const format of ["html", "json", "pdf", "markdown"]) {
        await page.locator(`#formatOptions input[value=${format}]`).setChecked(["html", "json"].includes(format));
    }
    const preview = await scanReport(page);
    assert.equal(preview.snapshot.selectionScope.kind, "selected");
    assert.equal(preview.snapshot.selectionScope.requestGroups, 1);
    assert.ok(JSON.stringify(preview.snapshot).includes(message));
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    const [saved] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + "/api/export"),
        page.getByRole("button", { name: "Save report", exact: true }).click(),
    ]);
    assert.equal(saved.status(), 200);
    const { bundle } = await saved.json();
    const html = Object.values(bundle.files).find(file => file.endsWith(".html"));
    assert.ok((await readFile(html, "utf8")).includes(message));
    assert.equal(checks.length, 1, "Status, navigation and report reads cannot repeat the source check.");
    assert.deepEqual(await readFile(configFile), config, "Explicit Refresh must not resume the paused collector.");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
});

test("fresh Copilot-only ordinary app preserves Settings category navigation and local Sign in without any Microsoft entry or source approval",
    { timeout: 30000 }, async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), "workiq-evidence-test-"));
        const dataDir = path.join(root, "data"), copilotHome = path.join(root, "no-copilot-source");
        const githubHome = path.join(root, "no-github-profile");
        await Promise.all([mkdir(copilotHome), mkdir(githubHome)]);
        const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
            name !== "NODE_TEST_CONTEXT" && name !== "NODE_OPTIONS" && !name.startsWith("WIRE_")
            && !/^(?:GH|GITHUB|COPILOT)(?:_[A-Z0-9]+)*_TOKEN$/i.test(name)));
        const child = fork(new URL("../scripts/start.mjs", import.meta.url), ["--port", "0"], {
            env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: dataDir, COPILOT_HOME: copilotHome, GH_CONFIG_DIR: githubHome },
            execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const exited = new Promise(resolve => child.once("exit", resolve));
        let browser, timer, output = "", stderr = "";
        t.after(async () => {
            clearTimeout(timer);
            try { await browser?.close(); }
            finally {
                if (child.connected) child.disconnect();
                const force = setTimeout(() => child.kill(), 5000);
                try { assert.equal(await exited, 0, "The isolated ordinary launcher must close cleanly."); }
                finally { clearTimeout(force); await rm(root, { recursive: true, force: true }); }
            }
        });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const url = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Isolated ordinary readiness timed out: " + stderr)), 15000);
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Isolated ordinary startup exited: " + stderr)));
            child.stdout.on("data", chunk => {
                output += chunk;
                const ready = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
                if (ready) resolve(ready[1]);
            });
        });
        clearTimeout(timer);
        const origin = new URL(url).origin;
        const post = async (route, input = {}, capability) => {
            const response = await fetch(origin + route, { method: "POST",
                headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}) },
                body: JSON.stringify(input) });
            assert.equal(response.status, 200);
            return response.json();
        };
        const handshake = await post("/api/session");
        assert.equal(handshake.accessBootstrap.collectionMode, "copilot-only");
        const access = await fetch(origin + "/api/access/status", { headers: { "X-Board-Capability": handshake.capability } });
        assert.equal(access.status, 200);
        assert.equal((await access.json()).collection, "paused");
        const sources = await post("/api/collection/sources/status", {}, handshake.capability);
        assert.equal(sources.github.status.config, null);
        assert.equal(sources.github.status.suggestedSource.appDbPath, path.join(copilotHome, "data.db"));
        assert.equal(sources.github.status.suggestedSource.available, false);
        assert.equal(Object.hasOwn(sources, "microsoft"), false);
        browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.setDefaultTimeout(5000);
        const blocked = [], errors = [], wireCommands = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => {
            const request = route.request(), address = new URL(request.url());
            if (address.origin === origin && address.pathname === "/api/access/command"
                && ["wire-sign-in", "wire-sign-out"].includes(request.postDataJSON().action)) {
                wireCommands.push(request.postDataJSON());
                return route.continue();
            }
            if (address.origin === origin && address.pathname === "/api/collection/global/enabled") return route.continue();
            if (address.origin !== origin || /\/api\/(?:access\/command|collection\/.*(?:enroll|configure|enabled|now)|export|preview|privacy-review|deletion\/confirm)$/.test(address.pathname)) {
                blocked.push(address.pathname);
                return route.abort();
            }
            return route.continue();
        });
        await page.goto(url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await navigateMain(page, "settings");
        await expect(page.locator("#connectionTitle")).toBeFocused();
        await assertSettingsCategoryNavigation(page);
        await page.setViewportSize({ width: 375, height: 1000 });
        // The responsive observer must collapse the rail before choosing a keyboard target.
        await expect(page.locator("#settingsCategories")).not.toHaveAttribute("open");
        await assertSettingsCategoryNavigation(page, { keyboard: true });
        await expect(page.locator("#settingsCategories")).not.toHaveAttribute("open");
        await page.goBack();
        await expect(page.locator("[data-settings-section=troubleshooting]")).toBeVisible();
        await page.goForward();
        await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
        await page.setViewportSize({ width: 1440, height: 1000 });
        const categoryLink = await page.locator("#settingsCategoryNav [data-category=privacy]").elementHandle();
        await page.locator("#wireAccountTrigger").click();
        await expect(page.locator("#wireAccountGate")).toHaveText("Sign out of this instance");
        await page.locator("#wireAccountGate").click();
        await expect(page.locator("#accessShell")).toBeVisible();
        await expect(page.locator("#workspace")).toBeHidden();
        const signedOutUrl = page.url();
        await categoryLink.evaluate(node => node.click());
        assert.equal(page.url(), signedOutUrl, "A held category link cannot bypass current access.");
        await expect(page.locator("#workspace")).toBeHidden();
        await page.reload();
        await expect(page.locator("#accessShell")).toBeVisible();
        await page.locator("#accessAccount").click();
        await expect(page.locator("#wireAccountMenu")).toBeVisible();
        await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
        await expect(page.locator("#wireAccountGate")).toBeEnabled();
        await expect(page.locator("#wireAccountGate")).toBeFocused();
        if (process.env.WIRE_NORMAL_CONNECT_PROOF) {
            await mkdir(path.dirname(process.env.WIRE_NORMAL_CONNECT_PROOF), { recursive: true });
            await page.screenshot({ path: path.join(path.dirname(process.env.WIRE_NORMAL_CONNECT_PROOF), "ordinary-signed-out-menu.png") });
        }
        await page.keyboard.press("Enter");
        await expect(page.locator("#workspace")).toBeVisible();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.keyboard.press("Escape");
        await assertSettingsCategoryNavigation(page);
        assert.deepEqual(wireCommands.map(command => command.action), ["wire-sign-out", "wire-sign-in"]);
        await expect(page.locator("#wireMicrosoftConnection")).toHaveCount(0);
        await expect(page.locator("#wireMicrosoftPrepare")).toHaveCount(0);
        await expect(page.locator("#sourceMicrosoftCollection")).toBeHidden();
        await page.locator("#settingsSearch").fill("Microsoft");
        await expect(page.locator("#settingsSearchResults")).not.toContainText("Microsoft 365 connection");
        await expect(page.locator("#settingsSearchResults")).not.toContainText("Microsoft collection");
        await page.locator("#settingsSearch").fill("");
        const current = await post("/api/collection/sources/status", {}, handshake.capability);
        await post("/api/collection/global/enabled", { schemaVersion: 1, enabled: false,
            generation: current.generation, authorizationRevision: current.authorizationRevision,
            expectedRevision: current.global.revision }, handshake.capability);
        await page.reload();
        await expect(page.locator("#globalCollectionStatus")).toHaveText("Paused");
        await expect(page.locator("#resumeGlobalCollection")).toBeEnabled();
        let resumeWrites = 0;
        await page.route("**/api/collection/global/enabled", async route => {
            resumeWrites++;
            await route.fetch();
            await route.abort("failed");
        });
        await page.locator("#resumeGlobalCollection").click();
        await expect(page.locator("#globalCollectionMessage")).toContainText("unconfirmed");
        await expect(page.locator("#readGlobalCollection")).toBeVisible();
        await page.locator("#readGlobalCollection").click();
        await expect(page.locator("#globalCollectionControls")).toBeHidden();
        assert.equal(resumeWrites, 1, "Read-only recovery must not replay the lost Resume response.");
        assert.equal((await post("/api/collection/sources/status", {}, handshake.capability)).global.paused, false);
        if (process.env.WIRE_NORMAL_CONNECT_PROOF) {
            await mkdir(path.dirname(process.env.WIRE_NORMAL_CONNECT_PROOF), { recursive: true });
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: process.env.WIRE_NORMAL_CONNECT_PROOF, fullPage: true });
        }
        for (const relative of ["microsoft-source.json", "microsoft-native", "collector\\config.json"]) {
            await assert.rejects(stat(path.join(dataDir, relative)), { code: "ENOENT" });
        }
        const board = await loadBoardState({ dataDir }, { readOnly: true });
        assert.equal(board.evidenceFile, undefined);
        assert.equal(Object.keys(board.cards).length, 0);
        assert.equal(board.exports.length, 0);
        assert.equal(board.nativeRetention, undefined);
        assert.deepEqual(blocked, [], "Only local access and explicit global Pause may change; no source is approved or contacted.");
        assert.deepEqual(errors, []);
    });

for (const repliesEnabled of [false, true]) test(`Copilot-only ordinary app preserves GitHub readers and reviewed reports while automatic collection advances${repliesEnabled ? " with existing reply saving enabled" : ""}`,
    { timeout: 240000 }, async t => {
        const cleanups = [], { root, context } = await privateFixture({ after: work => cleanups.push(work) }, []);
        let collector, child, exited, browser, readyTimer;
        const errors = [], external = [], mutations = [], nativeSearchRequests = [];
        t.after(async () => {
            clearTimeout(readyTimer);
            let exitCode;
            try {
                await browser?.close();
            } finally {
                try {
                    if (child) {
                        if (child.connected) child.disconnect();
                        const killTimer = setTimeout(() => child.kill(), 5000);
                        try { exitCode = await exited; }
                        finally { clearTimeout(killTimer); }
                    }
                } finally {
                    await collector?.close();
                    for (const cleanup of cleanups.reverse()) await cleanup();
                }
            }
            if (child) assert.equal(exitCode, 0, "The owned disposable launcher must close cleanly.");
        });
        const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
        const sourceId = randomUUID(), file = path.join(sessionRoot, sourceId, "events.jsonl");
        const db = new DatabaseSync(appDbPath);
        try {
            db.exec(metadata174Schema);
            db.prepare("INSERT INTO sessions(id,title,session_type,execution_location) VALUES(?,?,?,?)")
                .run(sourceId, "Invented ordinary app history", "chat", "local");
        } finally { db.close(); }
        const events = content => {
            const toolCallId = randomUUID(), timestamp = new Date().toISOString();
            return [
                { type: "user.message", data: { content } },
                { type: "tool.execution_start", data: { toolName: "workiq-retrieve", toolCallId,
                    arguments: { query: "invented ordinary app history" } } },
                { type: "tool.execution_complete", data: { toolCallId, success: true } },
            ].map(event => ({ ...event, id: randomUUID(), timestamp }));
        };
        const lines = rows => rows.map(row => JSON.stringify(row) + "\n").join("");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, lines([{ id: randomUUID(), type: "session.start", timestamp: new Date().toISOString(),
            data: { sessionId: sourceId, version: 1 } }, ...events("Ordinary seed request."),
            ...(repliesEnabled ? [{ id: randomUUID(), type: "assistant.message", timestamp: new Date().toISOString(),
                data: { content: "Invented earlier reply before saving was enabled." } }] : [])]));
        collector = await createCollector(context, { timers: false });
        await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
        await collector.collectNow();
        const initial = await loadBoardState(context), exports = createExportController(context);
        assert.equal(initial.evidence.length, 1);
        if (repliesEnabled) {
            const source = collector.assessmentSource(initial);
            await executeAssessmentAction(context, "ordinary-app-consent-fixture", "set_assessment_consent", {
                schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`,
                expectedSourceRevision: initial.evidenceRevision, expectedConsentRevision: 0,
                policyVersion: 1, enabled: true, categories: ["answer"],
                sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
            }, { source: state => collector.assessmentSource(state) });
        }
        const preparation = await loadBoardState(context);
        const preview = await exports.preview("ordinary-app-fixture", undefined, {
            title: "Preserved ordinary report", promptMode: "none", formats: ["html", "json"],
        }, { kind: "all", revision: preparation.revision });
        await exports.review("ordinary-app-fixture", preview.previewId, true);
        const { bundle } = await exports.confirm("ordinary-app-fixture", preview.previewId, true);
        const before = await loadBoardState(context);
        assert.equal(before.stateVersion, 3, "Exercise the pre-native production format.");
        const configFile = path.join(context.dataDir, "collector", "config.json");
        const configBytes = await readFile(configFile);
        const frozen = new Map(await Promise.all(Object.values(bundle.files).map(async name => [name, await readFile(name)])));
        await collector.close();
        collector = null;
        await assert.rejects(stat(path.join(context.dataDir, "microsoft-source.json")), { code: "ENOENT" });
        await assert.rejects(stat(path.join(context.dataDir, "microsoft-session")), { code: "ENOENT" });

        const environment = Object.fromEntries(Object.entries(process.env)
            .filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("WIRE_")
                && !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(name)));
        child = fork(new URL("../scripts/start.mjs", import.meta.url), ["--port", "0"], {
            env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: context.dataDir, GH_CONFIG_DIR: path.join(root, "no-profile") },
            execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        exited = new Promise(resolve => child.once("exit", resolve));
        let output = "", stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; });
        const url = await new Promise((resolve, reject) => {
            readyTimer = setTimeout(() => reject(new Error("Ordinary launcher readiness timed out: " + stderr)), 15000);
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Ordinary launcher exited before readiness: " + stderr)));
            child.stdout.on("data", chunk => {
                output += chunk;
                const found = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
                if (found) resolve(found[1]);
            });
        });
        clearTimeout(readyTimer);
        const origin = new URL(url).origin;
        const sessionResponse = await fetch(origin + "/api/session", { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" });
        assert.equal(sessionResponse.status, 200);
        const handshake = await sessionResponse.json();
        assert.equal(handshake.accessBootstrap.collectionMode, "copilot-only");
        assert.equal(handshake.accessBootstrap.mode, "enforced");

        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const proofs = process.env.WIRE_INTEGRATED_PROOFS && (repliesEnabled
            ? path.join(process.env.WIRE_INTEGRATED_PROOFS, "reply-saving-enabled") : process.env.WIRE_INTEGRATED_PROOFS);
        if (proofs) await mkdir(proofs, { recursive: true });
        async function capture(name) {
            if (!proofs) return;
            for (const theme of ["light", "dark"]) {
                await page.setViewportSize({ width: 1440, height: 1000 });
                await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
                await chooseTheme(page, theme);
                for (const [width, text] of [[1440, 100], [768, 100], [390, 200]]) {
                    await page.setViewportSize({ width, height: 1000 });
                    await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, text);
                    await page.evaluate(() => document.fonts.ready);
                    await page.waitForFunction(() => [...document.querySelectorAll("#main,#sidebar,#contextSidebar,#analyzeFilterDialog")]
                        .every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
                    if (name === "search") {
                        await page.locator("#wireSearch").focus();
                        await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
                    }
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false,
                        `${name}/${theme}/${width}/${text}: no page-level horizontal overflow`);
                    await page.screenshot({ path: path.join(proofs, `${name}-${theme}-${width}-${text}.png`) });
                }
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        }
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) errors.push(message.text());
        });
        page.on("request", request => {
            const route = new URL(request.url()).pathname;
            if (route === "/api/retained/microsoft/search") nativeSearchRequests.push(route);
            if (/^\/api\/(?:access\/command|export|artifact-deletion\/confirm|collection\/.*(?:configure|enabled|enroll|now))$/.test(route)) {
                mutations.push(route);
            }
        });
        await page.route("**/*", route => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            external.push(route.request().url());
            return route.abort();
        });
        await page.goto(url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#workspace")).toBeVisible();
        await expect(page.getByRole("region", { name: "Tool call results", exact: true })).toContainText("1 Work IQ tool call");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#collectionNoticeText")).not.toContainText("Microsoft connection status is unavailable");
        if (repliesEnabled) {
            const started = await loadBoardState(context, { readOnly: true });
            assert.deepEqual(started.personalEvaluation.consent, before.personalEvaluation.consent);
            assert.equal(started.personalEvaluation.captures.length, 0, "Startup cannot backfill the consumed reply from before consent.");
        }
        await capture("analyze");
        await openAnalyzeFilters(page);
        await expect(page.locator("#sourceFilter-control")).toBeVisible();
        await capture("filters");
        await closeAnalyzeFilters(page);
        await page.locator("#activityList .request-card-open").click();
        await expect(page.locator("#requestContent")).toContainText("Ordinary seed request.");
        await capture("reader");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await page.locator("#wireSearch").fill("workiq-retrieve");
        await expect(page.locator("#wireSearchResults button").first()).toBeVisible({ timeout: 20000 });
        await expect(page.locator("#wireNativeSearch")).toBeHidden();
        await expect(page.locator("#workspace")).toBeVisible();
        assert.deepEqual(nativeSearchRequests, [], "An unenrolled native source cannot retire valid GitHub access through an unauthorized Search.");
        await capture("search");
        await page.locator("#wireSearch").fill("");
        await navigateMain(page, "reports");
        await openReportLibrary(page);
        await expect(page.locator("#bundleList")).toContainText("Preserved ordinary report");
        await capture("library");
        await page.getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toHaveText("Preserved ordinary report");
        await page.getByRole("button", { name: "Back to report library", exact: true }).click();
        assert.deepEqual(mutations, [], "Read-only journeys must not infer source, account or report consent.");

        await chooseReportScope(page, "all");
        await capture("report-picker");
        await expect(page.locator("#reportContinue"), await page.locator("#reportStage1").innerText()).toBeEnabled();
        await reportContents(page);
        await page.locator("#reportTitle").fill("Ordinary reviewed snapshot");
        await page.locator("[name=promptMode][value=none]").check();
        for (const format of ["html", "json", "pdf", "markdown"]) {
            await page.locator(`#formatOptions input[value=${format}]`).setChecked(["html", "json"].includes(format));
        }
        const reviewedPreview = await scanReport(page);
        assert.equal(reviewedPreview.snapshot.selectionScope.requestGroups, 1);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
        await capture("reviewed");
        await appendFile(file, lines([...events("Later ordinary activity collected automatically."),
            ...(repliesEnabled ? [{ id: randomUUID(), type: "assistant.message", timestamp: new Date().toISOString(),
                data: { content: "Invented new reply after the existing consent." } }] : [])]));
        await expect.poll(async () => (await loadBoardState(context, { readOnly: true })).evidence.length, { timeout: 20000 }).toBe(2);
        if (repliesEnabled) await expect.poll(async () =>
            (await loadBoardState(context, { readOnly: true })).personalEvaluation.captures.length, { timeout: 10000 }).toBe(1);
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
        const [savedResponse] = await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname === "/api/export"),
            page.getByRole("button", { name: "Save report", exact: true }).click(),
        ]);
        const savedResult = await savedResponse.json();
        assert.equal(savedResponse.status(), 200, savedResult.error ?? savedResult.code);
        const reviewedBundle = savedResult.bundle;
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const savedState = await loadBoardState(context, { readOnly: true });
        const reviewedEntry = savedState.exports.find(entry => entry.bundleId === reviewedBundle.bundleId);
        assert.equal(reviewedEntry.selectionScope.requestGroups, 1, "Newly collected activity must not broaden the reviewed scope.");
        await capture("saved");
        await openReportLibrary(page);
        await page.locator(`[data-bundle-id="${reviewedBundle.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toHaveText("Ordinary reviewed snapshot");
        await capture("saved-reader");
        await page.getByRole("button", { name: "Back to report library", exact: true }).click();
        await openReportComparison(page);
        const comparison = page.locator("#comparisonWorkspace");
        for (const [index, label] of ["Earlier report", "Later report"].entries()) {
            await comparison.getByRole("combobox", { name: label, exact: true }).click();
            await page.locator(`.select-popup .select-option[data-value="${[bundle.bundleId, reviewedBundle.bundleId][index]}"]`).click();
        }
        await comparison.getByRole("button", { name: "Compare reports", exact: true }).click();
        await expect(comparison.getByRole("button", { name: "Prepare comparison copy", exact: true })).toBeEnabled();
        await capture("comparison");
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        await expect(page.locator("#globalCollectionControls")).toBeHidden();
        await expect(page.locator("#sourceMicrosoftCollection")).toBeHidden();
        await expect(page.locator("#wireMicrosoftConnection")).toHaveCount(0);
        await capture("settings-unenrolled");
        assert.deepEqual(await readFile(configFile), configBytes);
        await assert.rejects(stat(path.join(context.dataDir, "microsoft-source.json")), { code: "ENOENT" });
        assert.deepEqual(mutations, ["/api/export"], "Only the explicitly reviewed report has been saved.");
        const refresh = await revealStoredRefresh(page);
        await expect(refresh).toBeEnabled();
        const [refreshed] = await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname === "/api/collection/now"),
            refresh.click(),
        ]);
        assert.equal(refreshed.status(), 200);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

        await navigateMain(page, "analyze");
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.getByRole("region", { name: "Tool call results", exact: true })).toContainText("2 Work IQ tool calls");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        const after = await loadBoardState(context, { readOnly: true });
        assert.equal(after.pseudonymKey, before.pseudonymKey);
        assert.equal(after.stateVersion, 3);
        if (repliesEnabled) {
            assert.equal(after.personalEvaluation.consent.state, "enabled");
            assert.deepEqual(after.personalEvaluation.consent, before.personalEvaluation.consent);
            assert.equal(after.personalEvaluation.captures.length, 1);
        }
        for (const name of ["nativeRetention", "nativeReportPolicy", "globalCollection"]) assert.equal(after[name], undefined);
        assert.equal(after.exports.length, before.exports.length + 1);
        for (const entry of before.exports) assert.deepEqual(after.exports.find(value => value.bundleId === entry.bundleId), entry);
        for (const [id, card] of Object.entries(before.cards)) assert.deepEqual(after.cards[id], card);
        assert.deepEqual(await readFile(configFile), configBytes);
        for (const [name, bytes] of frozen) assert.deepEqual(await readFile(name), bytes);
        assert.deepEqual(mutations, ["/api/export", "/api/collection/now"], "Only the explicit report Save and approved GitHub Refresh are dispatched.");
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        await page.locator("#pauseCollection").click();
        await expect(page.locator("#pauseCollection")).toHaveText("Resume collection");
        await expect(page.locator("#checkActivity")).toBeEnabled();
        assert.equal(JSON.parse(await readFile(configFile, "utf8")).enabled, false);
        await page.reload();
        await expect(page.locator("#pauseCollection")).toHaveText("Resume collection");
        await expect(page.locator("#checkActivity")).toBeEnabled();
        await page.locator("#pauseCollection").click();
        await expect(page.locator("#pauseCollection")).toHaveText("Pause collection");
        assert.deepEqual(await readFile(configFile), configBytes);
        const controlHeaders = { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": handshake.capability };
        const composite = await fetch(origin + "/api/collection/sources/status", {
            method: "POST", headers: controlHeaders, body: "{}",
        }).then(response => response.json());
        const pausedGlobal = await fetch(origin + "/api/collection/global/enabled", { method: "POST", headers: controlHeaders,
            body: JSON.stringify({ schemaVersion: 1, enabled: false, generation: composite.generation,
                authorizationRevision: composite.authorizationRevision, expectedRevision: composite.global.revision }) });
        assert.equal(pausedGlobal.status, 200);
        await page.reload();
        await expect(page.locator("#globalCollectionStatus")).toHaveText("Paused");
        await expect(page.locator("#pauseCollection")).toBeHidden();
        await expect(page.locator("#checkActivity")).toBeEnabled();
        await capture("settings-paused");
        await page.locator("#resumeGlobalCollection").click();
        await expect(page.locator("#globalCollectionControls")).toBeHidden();
        await expect(page.locator("#pauseCollection")).toHaveText("Pause collection");
        assert.deepEqual(await readFile(configFile), configBytes);
        assert.deepEqual(external, [], "The unenrolled app must not request remote browser resources.");
        assert.deepEqual(errors, []);
        if (proofs && process.env.WIRE_INTEGRATED_INSPECT) {
            const result = await promisify(execFile)(process.execPath, [process.env.WIRE_INTEGRATED_INSPECT,
                "--app", url, "--out", path.join(proofs, "inspection")], { timeout: 60000, maxBuffer: 1024 * 1024 });
            t.diagnostic(result.stdout);
        }
    });
