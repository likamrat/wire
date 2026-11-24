import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { buildSanitizedBundle, createExportController, writeBundle } from "../lib/export.mjs";
import { createCollector, collectorFor } from "../lib/collector.mjs";
import { exclusiveBoard, loadBoardState } from "../lib/store.mjs";
import { assessmentHash } from "../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { readSavedReportFile } from "../lib/report-artifacts.mjs";
import { privateFixture, fixture, navigateMain, navigateSettings, chooseTheme } from "./helpers.mjs";
import { quality, samples } from "./assessment-ui-fixtures.mjs";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";
import { openReportLibrary } from "./report-journey-helpers.mjs";
import { contrast, rgb } from "./color-measurements.mjs";

async function settled(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
}
async function browserFor(runtime, extraReads = []) {
    const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], forbidden = [], calls = [];
    const allowed = new Set([
        "/api/session", "/api/snapshot", "/api/collection/status",
        "/api/assessment/detail", "/api/assessment/consent",
        "/api/assessment/evidence", "/api/assessment/consent/set", "/api/assessment/mutation/status",
        ...extraReads,
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

test("an uncertain reply-saving change recovers after reload without replaying it or consuming historical personal feedback", async t => {
    const cleanups = [], f = await retirementFixture({ after: action => cleanups.push(action) });
    const runtime = await startServer(f.context, createExportController(f.context), { port: 0, collector: { timers: false } });
    const { page, calls, close } = await browserFor(runtime);
    t.after(async () => {
        try { await close(); } finally { try { await runtime.close(); } finally { for (const action of cleanups.reverse()) await action(); } }
    });
    const before = (await loadBoardState(f.context)).personalEvaluation;
    const legacy = JSON.stringify({ mutationRef: f.personalMutationRef, receiptToken: f.receiptToken, action: "set_personal_assessment" });
    await page.goto(runtime.url + "settings?section=privacy"); await settled(page);
    await page.evaluate(raw => sessionStorage.setItem("wire.assessment.pending", raw), legacy);
    await page.reload(); await settled(page);
    let committed, writes = 0, sent;
    await page.route("**/api/assessment/consent/set", async route => {
        writes++; sent = route.request().postDataJSON();
        committed = (await route.fetch()).status();
        await route.abort("connectionreset");
    });
    await page.getByRole("switch", { name: "Save Copilot replies locally" }).check();
    await page.getByRole("button", { name: "Turn on response saving" }).click();
    const recover = page.getByRole("button", { name: "Check response-saving result", exact: true });
    await expect(recover).toBeEnabled();
    assert.equal(committed, 200);
    const accepted = (await loadBoardState(f.context)).personalEvaluation;
    assert.equal(accepted.consent.state, "enabled");
    await page.reload(); await settled(page);
    const read = page.waitForResponse(r => r.url().endsWith("/api/assessment/mutation/status"));
    await recover.click();
    const response = await read;
    assert.equal(response.status(), 200);
    assert.deepEqual(response.request().postDataJSON(), { schemaVersion: 1, mutationRef: sent.mutationRef, receiptToken: sent.receiptToken });
    await page.waitForFunction(() => sessionStorage.getItem("wire.responseCapture.pending") === null);
    await expect(page.getByRole("switch", { name: "Save Copilot replies locally" })).toBeChecked();
    assert.equal(writes, 1);
    assert.equal(calls.filter(p => p.endsWith("/mutation/status")).length, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")), legacy);
    assert.ok(!(await page.locator("body").textContent()).includes(sent.receiptToken));
    assert.deepEqual((await loadBoardState(f.context)).personalEvaluation, accepted);
    assert.deepEqual(accepted.feedback, before.feedback);
});

test("verified Open of historical JSON shows one pass and one fail over three interactions without a live rating queue", async t => {
    const cleanups = [], records = ["rated-pass", "rated-fail", "unrated"].map(id => {
        const r = fixture(id);
        r.userPrompt.sourceEventId = `message-${id}`;
        return r;
    });
    const { context } = await privateFixture({ after: action => cleanups.push(action) }, records);
    const state = await loadBoardState(context);
    // Build an invented JSON-only archive, not a live feedback action or a new report option.
    const archive = await buildSanitizedBundle(state.evidence, state.pseudonymKey, { promptMode: "none", formats: ["json"] });
    const facts = structuredClone(archive.snapshot.evaluationFacts), ids = facts.memberships.map(m => m.interactionRef);
    assert.equal(ids.length, 3);
    facts.metricProjectionVersion = 3;
    const assessments = ids.slice(0, 2).map((id, i) => ({
        ...samples.makeAssessment(true), assessmentRef: samples.id("assessment", i + 1), basis: facts.basis,
        interactionRef: id, unitRef: id, verdict: i ? "fail" : "pass",
    }));
    facts.assessments.push(...assessments);
    const historical = { ...quality("accuracy", { pass: 1, fail: 1, unassessed: 1, personal: true }),
        basis: facts.basis, eligibleUnitRefs: ids, coveredUnitRefs: ids.slice(0, 2), evidenceRefs: assessments.map(a => a.assessmentRef),
        unassessedReasons: [{ reason: "missing-evidence", count: 1 }],
        observedTime: { state: "withheld", firstAt: null, lastAt: null, datedUnits: 2, undatedUnits: 1 } };
    facts.metrics.push(historical);
    archive.snapshot.evaluationFacts = freezeEvaluationFacts(facts);
    archive.privacy.reviewerConfirmed = true;
    archive.privacy.confirmedAt = archive.snapshot.preparedAt;
    const bytes = JSON.stringify(archive.snapshot, null, 2) + "\n", name = "product-report.json", manifestName = "coverage-and-redaction-manifest.json";
    archive.files[name] = bytes;
    const manifest = JSON.parse(archive.files[manifestName]);
    Object.assign(manifest, { evaluationFacts: facts, evaluationFactsHash: assessmentHash(JSON.stringify(facts)),
        snapshotHash: assessmentHash(JSON.stringify(archive.snapshot)), privacyReview: archive.privacy });
    manifest.files[name] = { sha256: assessmentHash(bytes), bytes: Buffer.byteLength(bytes) };
    archive.files[manifestName] = JSON.stringify(manifest, null, 2);
    const saved = await exclusiveBoard(context, async (state, save) => {
        const entry = await writeBundle(context, archive, state);
        state.exports.push(entry); state.revision++; await save(state);
        return entry;
    });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const { page, calls, close } = await browserFor(runtime, ["/api/report/open"]);
    t.after(async () => {
        try { await close(); } finally { try { await runtime.close(); } finally { for (const action of cleanups.reverse()) await action(); } }
    });
    await page.goto(runtime.url); await settled(page);
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(3);
    await expect(page.locator("#activityList")).not.toContainText(/Your feedback|Personal feedback|rate this/i);
    await page.locator('#activityList [data-view-key="request:unrated"] .request-card-open').click();
    await expect(page.locator("#contextSidebar")).toContainText("Saving is off by default");
    await expect(page.locator("#contextSidebar")).not.toContainText(/Your feedback|Personal feedback/i);
    assert.ok(!calls.includes("/api/assessment/evidence"));
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "reports"); await openReportLibrary(page);
    const entry = page.locator(`#bundleList [data-bundle-id="${saved.bundleId}"]`);
    const opening = page.waitForResponse(r => r.url().endsWith("/api/report/open"));
    await entry.locator(".saved-report-title").click();
    const opened = await opening;
    assert.equal(opened.status(), 200, await opened.text());
    assert.equal((await opened.json()).sourceFormat, "json");
    const qualityTable = page.frameLocator("#savedReportReader iframe").locator("#quality");
    await expect(qualityTable).toContainText("Personal feedback");
    await expect(qualityTable).toContainText("50%");
    await expect(qualityTable).toContainText(/2 (?:of|\/) 3/);
    const file = await readSavedReportFile(context, await loadBoardState(context), saved.bundleId, "json");
    const metric = file.snapshot.evaluationFacts.metrics.find(m => m.metricRef === historical.metricRef);
    assert.deepEqual(metric.unassessedReasons, historical.unassessedReasons);
    assert.deepEqual(metric.observedTime, historical.observedTime);
    assert.equal(await readFile(saved.files[name], "utf8"), bytes);
    assert.equal(await readFile(saved.files[manifestName], "utf8"), archive.files[manifestName]);
    assert.equal((await loadBoardState(context)).personalEvaluation, undefined);
    // A syntactically valid but altered file cannot display that same verified interpretation.
    await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
    await appendFile(saved.files[name], "\n");
    const refusing = page.waitForResponse(r => r.url().endsWith("/api/report/open"));
    await entry.locator(".saved-report-title").click();
    assert.equal((await refusing).status(), 409);
    await expect(page.locator("#savedReportReader .error")).toBeVisible();
    await expect(page.locator("#savedReportReader iframe")).toHaveCount(0);
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
    const { context, page, calls, close } = await browserFor(runtime);
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
    // The enable receipt can arrive before the page has applied its refreshed source state.
    const gate = Promise.withResolvers();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await gate.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    const turnOff = setup.getByRole("button", { name: "Turn off and delete responses", exact: true });
    let refreshRequest, consentRevision, editedBeforeRefresh;
    try {
        const [enable, read] = await Promise.all([page.waitForResponse("**/api/assessment/consent/set"),
            page.waitForRequest("**/api/snapshot"), setup.getByRole("button", { name: "Turn on response saving", exact: true }).click()]);
        assert.ok(enable.ok());
        consentRevision = (await enable.json()).basis.consentRevision;
        refreshRequest = read;
        await expect(checkbox).toBeChecked();
        editedBeforeRefresh = await checkbox.isEnabled();
        if (editedBeforeRefresh) {
            await checkbox.uncheck();
            await expect(turnOff).toBeEnabled();
        }
    } finally {
        gate.resolve();
        await page.unrouteAll({ behavior: "wait" });
    }
    const refreshed = await refreshRequest.response();
    assert.ok(refreshed?.ok());
    assert.equal((await refreshed.json()).assessment.basis.consentRevision, consentRevision);
    await settled(page);
    if (!editedBeforeRefresh) await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await expect(turnOff).toBeEnabled();
    assert.equal((await loadBoardState(session)).personalEvaluation.consent.state, "enabled", "An unchecked draft is not a revocation.");
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
    const held = await other.getByText(text, { exact: true }).elementHandle();
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
    await expect(other.locator("#contextSidebar")).not.toContainText(text, { timeout: 15000 });
    assert.ok(!(await held.evaluate(node => node.textContent)).includes(text), "Withdraw even a held, detached reply node.");
    state = await loadBoardState(session);
    assert.equal(state.personalEvaluation.consent.state, "revoked");
    assert.equal(state.personalEvaluation.captures.length, 0);
    assert.equal(state.evidence.length, 1, "Revocation preserves ordinary retained activity.");
    for (const [file, bytes] of frozen) assert.deepEqual(await readFile(file), bytes, "Revocation preserves frozen report files.");
    assert.equal(calls.filter(path => path === "/api/assessment/consent/set").length, 2);
});
