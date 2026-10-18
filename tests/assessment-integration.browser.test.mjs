import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollector, collectorFor } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { privateFixture, fixture, openActivitySessions, navigateMain, navigateSettings, chooseTheme, revealStoredRefresh } from "./helpers.mjs";
import { contrast, rgb } from "./color-measurements.mjs";

async function settled(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
}
async function browserFor(t, runtime) {
    const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], forbidden = [], calls = [];
    const allowed = new Set([
        "/api/session", "/api/snapshot", "/api/collection/status",
        "/api/evaluation/automatic/summary",
        "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent",
        "/api/assessment/evidence", "/api/assessment/feedback", "/api/assessment/consent/set", "/api/assessment/mutation/status",
    ]);
    await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || allowed.has(url.pathname))) {
            if (request.method() === "POST") calls.push(url.pathname);
            return route.continue();
        }
        forbidden.push(url.href); return route.abort();
    });
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    const close = async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); };
    return { context, page: await context.newPage(), calls, close };
}
test("one-click actual interaction read, personal revisions and withdrawal persist through real routes without capture", { timeout: 30000 }, async t => {
    const record = fixture("interaction-ui");
    record.userPrompt.sourceEventId = "artificial-message";
    record.toolCalls[0].completionEventId = "artificial-completion";
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const { page, calls, close } = await browserFor(t, runtime);
    t.after(async () => {
        try { await close(); }
        finally { try { await runtime.close(); } finally { for (const action of cleanup) await action(); } }
    });
    const before = await loadBoardState(context);
    await page.goto(runtime.url + "#activity"); await settled(page); await openActivitySessions(page);
    await page.getByRole("link", { name: "View interaction", exact: true }).first().click(); await settled(page);
    await page.locator(".interaction-insights .assessment-grid").waitFor();
    assert.deepEqual(await page.locator(".interaction-insights .assessment-check .assessment-value").allTextContents(), ["No result", "No result", "No result"]);
    assert.equal((await loadBoardState(context)).personalEvaluation, undefined);
    assert.equal(calls.includes("/api/assessment/evidence"), false);
    assert.equal(calls.includes("/api/assessment/consent/set"), false);
    await page.locator(".interaction-insights").getByRole("button", { name: "Details and feedback", exact: true }).click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    let feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
    await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.getByRole("option", { name: "Correct", exact: true }).click();
    const write = page.waitForResponse(response => response.url().endsWith("/api/assessment/feedback"));
    await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
    assert.equal((await write).status(), 200);
    await page.waitForFunction(() => document.querySelector(".interaction-insights")?.textContent.includes("Your feedback"));
    await settled(page);
    let state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.feedback.records.length, 1);
    assert.equal(state.personalEvaluation.feedback.records[0].assessment.verdict, "pass");
    assert.equal(state.personalEvaluation.consent.state, "off");
    assert.deepEqual(state.evidence, before.evidence);
    assert.equal(await page.locator('.interaction-insights [data-dimension="accuracy"]').filter({ hasText: "Your feedback" }).locator(".assessment-value").innerText(), "Correct");
    await page.locator(".interaction-insights").getByRole("button", { name: "Details and feedback", exact: true }).click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
    assert.match(await feedback.textContent(), /revision 1/);
    const withdrawal = page.waitForResponse(response => response.url().endsWith("/api/assessment/feedback"));
    await feedback.getByRole("button", { name: "Withdraw feedback", exact: true }).click();
    assert.equal((await withdrawal).status(), 200);
    await settled(page);
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.feedback.records.length, 2);
    assert.equal(state.personalEvaluation.feedback.records[1].assessment.withdrawn, true);
    assert.equal(state.personalEvaluation.feedback.records[0].assessment.verdict, "pass");
    assert.deepEqual(state.evidence, before.evidence);
    assert.equal(calls.filter(path => path === "/api/assessment/feedback").length, 2);
    await page.locator(".interaction-insights").getByRole("button", { name: "Details and feedback", exact: true }).click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
    await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.getByRole("option", { name: "Not correct", exact: true }).click();
    const restored = page.waitForResponse(response => response.url().endsWith("/api/assessment/feedback"));
    await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
    const restoredResponse = await restored;
    assert.equal(restoredResponse.status(), 200, await restoredResponse.text());
    await page.waitForFunction(() => document.querySelector(".interaction-insights")?.textContent.includes("Your feedback"));
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.feedback.records[2].assessment.revision, 3);
    assert.equal(state.personalEvaluation.feedback.records[2].assessment.verdict, "fail");
    assert.deepEqual(state.evidence, before.evidence);
    if (process.env.WIRE_ASSESSMENT_PROOFS) {
        await mkdir(process.env.WIRE_ASSESSMENT_PROOFS, { recursive: true });
        for (const [theme, width, size] of [["light", 1200, 100], ["dark", 375, 100], ["dark", 320, 200]]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
            await page.evaluate(() => document.fonts.ready);
            await page.mouse.move(0, 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            const trustRowsAligned = await page.locator(".interaction-insights .assessment-fact-unavailable").evaluateAll(nodes =>
                nodes.filter(node => ["answer-trust", "action-trust"].includes(node.dataset.dimension)).every(node => {
                    const coverage = node.querySelector(".assessment-coverage").getBoundingClientRect(), value = node.querySelector(".assessment-value").getBoundingClientRect();
                    return coverage.bottom <= value.top;
                }));
            assert.equal(trustRowsAligned, true, "Trust coverage reads before unavailable results.");
            await page.screenshot({ path: path.join(process.env.WIRE_ASSESSMENT_PROOFS, `interaction-${theme}-${width}-${size}.png`), fullPage: true });
        }
    }
});

test("lost feedback receipt recovers after page renewal without resending the mutation or exposing its token", { timeout: 30000 }, async t => {
    const cleanup = [], record = fixture("receipt-recovery");
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const { page, close } = await browserFor(t, runtime);
    t.after(async () => {
        try { await close(); }
        finally { try { await runtime.close(); } finally { for (const action of cleanup) await action(); } }
    });
    let writes = 0, receiptToken, committedStatus;
    await page.route("**/api/assessment/feedback", async route => {
        writes++;
        receiptToken = route.request().postDataJSON().receiptToken;
        const response = await route.fetch();
        committedStatus = response.status();
        await route.abort("connectionreset");
    });
    await page.goto(runtime.url + "#request?request=receipt-recovery"); await settled(page);
    await page.locator(".interaction-insights").getByRole("button", { name: "Details and feedback", exact: true }).click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    const feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
    await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.getByRole("option", { name: "Correct", exact: true }).click();
    await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
    await feedback.getByRole("button", { name: "Check update result", exact: true }).waitFor();
    assert.equal(committedStatus, 200);
    assert.equal(/^[a-f0-9]{64}$/.test(receiptToken), true);
    assert.equal(await page.locator("body").textContent().then(text => text.includes(receiptToken)), false);
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
    await page.reload(); await settled(page);
    const recovered = page.waitForResponse(response => response.url().endsWith("/api/assessment/mutation/status"));
    await page.getByRole("button", { name: "Check earlier update", exact: true }).click();
    const recoveredResponse = await recovered;
    assert.equal(recoveredResponse.status(), 200);
    assert.equal((await recoveredResponse.json()).phase, "complete");
    await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
    assert.equal(writes, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
    assert.equal(await page.locator("body").textContent().then(text => text.includes(receiptToken)), false);
});

test("actual overview shows two personal ratings over three selected interactions without a rating queue", { timeout: 30000 }, async t => {
    const cleanup = [], records = ["rated-pass", "rated-fail", "unrated"].map(fixture);
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    for (const [index, verdict] of ["pass", "fail"].entries()) {
        const state = await loadBoardState(context), model = buildAssessmentModel(state);
        const interactionRef = model.catalog.find(item => item.scenarioId === records[index].scenarioId).interactionRef;
        await executeAssessmentAction(context, "synthetic-coverage", "set_personal_assessment", {
            schemaVersion: 1, mutationRef: "mutation-" + randomUUID().replaceAll("-", ""),
            interactionRef, expectedBasis: model.basis, checkId: "semantic-answer-correctness", verdict, withdraw: false,
        });
    }
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const { page, close, calls } = await browserFor(t, runtime);
    t.after(async () => {
        try { await close(); }
        finally { try { await runtime.close(); } finally { for (const action of cleanup) await action(); } }
    });
    await page.goto(runtime.url + "#home"); await settled(page);
    const personal = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Your feedback" });
    await personal.waitFor();
    assert.match(await personal.textContent(), /50%/);
    assert.match(await personal.textContent(), /1 \/ 2 passed; 2 \/ 3 assessed/);
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 2);
    assert.equal(calls.includes("/api/assessment/feedback"), false, "Overview does not create missing personal verdicts.");
    assert.equal(await page.getByRole("button", { name: /assess|grade/i }).count(), 0);
});

test("setup enable/cancel and cross-panel revocation operate only on an isolated synthetic source", { timeout: 45000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-assessment-ui-"));
    const dbPath = path.join(root, "data.db"), sourceRoot = path.join(root, "session-state"), sourceId = randomUUID();
    const database = new DatabaseSync(dbPath);
    database.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Artificial UI source", "chat", null, "local");
    await mkdir(path.join(sourceRoot, sourceId), { recursive: true });
    const log = path.join(sourceRoot, sourceId, "events.jsonl"), session = { dataDir: path.join(root, "store") };
    const event = (type, data, id = randomUUID()) => ({ id, type, timestamp: new Date().toISOString(), data });
    await writeFile(log, [
        event("session.start", { sessionId: sourceId, version: 1 }),
        event("user.message", { content: "Artificial request. Not real work data." }, "ui-prompt"),
        event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: "ui-call", arguments: { entityUrls: ["/me/messages"] } }),
        event("tool.execution_complete", { toolCallId: "ui-call", success: true }),
        event("assistant.message", { content: "ARTIFICIAL_OFF_RESPONSE" }),
    ].map(value => JSON.stringify(value) + "\n").join(""));
    let collector = await createCollector(session, { timers: false });
    await collector.configure({ appDbPath: dbPath, sessionRoot: sourceRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    await collector.close();
    const reports = createExportController(session);
    const runtime = await startServer(session, reports, { port: 0, collector: { timers: false } });
    collector = collectorFor(session);
    const { context, page, calls, close } = await browserFor(t, runtime);
    t.after(async () => {
        try { await close(); }
        finally {
            try { await runtime.close(); }
            finally { await collectorFor(session)?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
        }
    });
    await page.goto(runtime.url + "#settings?section=evidence"); await settled(page);
    const setup = page.locator("#assessmentSetup");
    await setup.getByRole("switch", { name: "Save Copilot replies locally", exact: true }).waitFor();
    const checkbox = setup.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    assert.equal(await page.locator('[data-settings-section="privacy"] h2').count(), 1, "Reply saving belongs to Privacy and saved data.");
    assert.equal(await page.locator("#assessmentSetupTitle").getAttribute("aria-label"), "Recorded replies");
    assert.equal(await setup.getByRole("heading", { name: "Save Copilot replies locally", exact: true }).count(), 1);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await setup.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
    assert.equal((await loadBoardState(session)).personalEvaluation, undefined);
    await checkbox.check();
    assert.equal(await setup.getByRole("button", { name: "Turn on response saving", exact: true }).isEnabled(), true);
    assert.equal(await setup.getByRole("button", { name: "Turn on response saving", exact: true }).evaluate(node => node.classList.contains("danger")), false,
        "First-time capture does not purge prior evidence");
    await setup.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await setup.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
    assert.equal(calls.includes("/api/assessment/consent/set"), false);
    await checkbox.check();
    const enable = page.waitForResponse(response => response.url().endsWith("/api/assessment/consent/set"));
    await setup.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    assert.equal((await enable).status(), 200);
    await page.waitForFunction(() => document.querySelector("#assessmentSetup input")?.checked && document.querySelector("#assessmentSetup button[type=submit]")?.hidden);
    assert.equal(await setup.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
    await checkbox.uncheck();
    assert.equal(await setup.getByRole("button", { name: "Turn off and delete responses", exact: true }).isEnabled(), true);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const value = await setup.getByRole("button", { name: "Turn off and delete responses", exact: true }).evaluate(node => {
            const style = getComputedStyle(node), face = getComputedStyle(node, "::before");
            const surface = face.content !== "none" && face.zIndex === "-1" ? face : style;
            let background = surface.backgroundColor, parent = node.parentElement;
            while (background === "rgba(0, 0, 0, 0)" && parent) {
                background = getComputedStyle(parent).backgroundColor;
                parent = parent.parentElement;
            }
            return { color: style.color, background, border: surface.borderColor, danger: style.getPropertyValue("--danger").trim(), height: node.getBoundingClientRect().height };
        });
        assert.deepEqual(rgb(value.color), rgb(value.danger));
        assert.deepEqual(rgb(value.border), rgb(value.danger));
        assert.notDeepEqual(rgb(value.background), rgb(value.danger));
        assert.ok(contrast(value.color, value.background) >= 4.5);
        assert.ok(value.height >= 44);
    }
    await setup.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await setup.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
    const text = "ARTIFICIAL_ON_RESPONSE \u65e5\u672c\u8a9e e\u0301";
    await appendFile(log, JSON.stringify(event("assistant.message", { content: text })) + "\n");
    await collector.collectNow();
    let state = await loadBoardState(session);
    assert.equal(state.personalEvaluation.captures.length, 1);
    const scenarioId = state.evidence[0].scenarioId;
    const other = await context.newPage();
    await other.goto(runtime.url + "#request?request=" + encodeURIComponent(scenarioId)); await settled(other);
    await other.getByText(text, { exact: true }).waitFor();
    assert.equal(calls.filter(path => path === "/api/assessment/evidence").length, 1);
    const preview = await reports.preview("synthetic-revoke-preservation", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "selected", revision: state.revision, scenarioIds: [scenarioId] });
    await reports.review("synthetic-revoke-preservation", preview.previewId, true);
    const saved = (await reports.confirm("synthetic-revoke-preservation", preview.previewId, true)).bundle;
    const frozen = await Promise.all(Object.values(saved.files).map(async file => [file, await readFile(file)]));
    await page.bringToFront();
    await page.reload(); await settled(page);
    await navigateMain(page, "settings"); await navigateSettings(page, "privacy");
    await page.waitForFunction(() => document.querySelector("#assessmentSetup input")?.checked && document.querySelector("#assessmentSetup button[type=submit]")?.hidden);
    await checkbox.uncheck();
    const revoke = page.waitForResponse(response => response.url().endsWith("/api/assessment/consent/set"));
    await setup.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    const revokeResponse = await revoke;
    assert.equal(revokeResponse.status(), 200, await revokeResponse.text());
    await other.bringToFront();
    await other.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await other.waitForFunction(text => !document.querySelector(".interaction-response")?.textContent.includes(text), text, { timeout: 15000 });
    state = await loadBoardState(session);
    assert.equal(state.personalEvaluation.consent.state, "revoked");
    assert.equal(state.personalEvaluation.captures.length, 0);
    assert.equal(state.evidence.length, 1, "Revocation preserves ordinary retained activity.");
    for (const [file, bytes] of frozen) assert.deepEqual(await readFile(file), bytes, "Revocation preserves frozen report files.");
    assert.equal(calls.filter(path => path === "/api/assessment/consent/set").length, 2);
});
