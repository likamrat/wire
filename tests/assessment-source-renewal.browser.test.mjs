import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { selectActivityOption } from "./helpers.mjs";

const event = (type, data, id = randomUUID()) => ({ id, type, timestamp: new Date().toISOString(), data });
const jsonl = values => values.map(value => JSON.stringify(value) + "\n").join("");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function interaction(name) {
    return [
        event("user.message", { content: `Artificial ${name} request` }, `${name}-prompt`),
        event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: `${name}-call`, arguments: { entityUrls: ["/me/messages"] } }),
        event("tool.execution_complete", { toolCallId: `${name}-call`, success: true }),
    ];
}
async function ready(page) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
}

test("actual source renewal is explicit, cleans prior optional evidence and leaves filters/time/polling/in-scope activity independent", { timeout: 60000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-source-renewal-"));
    const context = { dataDir: path.join(root, "store") }, databases = [], calls = [], errors = [], denied = [];
    let runtime, browser;
    t.after(async () => {
        try { await browser?.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); }
        finally {
            try { await runtime?.close(); }
            finally { for (const database of databases) database.close(); await rm(root, { recursive: true, force: true }); }
        }
    });
    async function source(name) {
        const folder = path.join(root, name), sessionRoot = path.join(folder, "session-state"), sourceId = randomUUID();
        await mkdir(path.join(sessionRoot, sourceId), { recursive: true });
        const appDbPath = path.join(folder, "data.db"), database = new DatabaseSync(appDbPath);
        databases.push(database);
        database.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
        database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, `Artificial ${name}`, "chat", null, "local");
        const file = path.join(sessionRoot, sourceId, "events.jsonl");
        await writeFile(file, jsonl([event("session.start", { sessionId: sourceId, version: 1 }), ...interaction(name)]));
        return { file, sourceId, config: { appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 } };
    }
    const a = await source("source-a"), b = await source("source-b"), reports = createExportController(context);
    runtime = await startServer(context, reports, { port: 0, collector: { timers: false } });
    await runtime.collector.configure(a.config);
    await runtime.collector.collectNow();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = url.origin === new URL(runtime.url).origin && (
            request.method() === "GET" && ["/", "/favicon.svg", "/assets/assessment-contract.mjs"].includes(url.pathname)
            || request.method() === "POST" && ["/api/session", "/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary",
                "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/consent",
                "/api/assessment/consent/set", "/api/assessment/evidence", "/api/assessment/mutation/status"].includes(url.pathname)
        );
        if (!allowed) { denied.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        if (request.method() === "POST") calls.push({ path: url.pathname, input: request.postDataJSON() });
        return route.continue();
    });
    async function settings() {
        const target = runtime.url + "#settings?section=evidence";
        // The legacy URL now canonicalizes to Collection preferences.
        if (await page.locator('[data-settings-section="collection"]').isVisible()) await page.reload();
        else await page.goto(target);
        await ready(page);
        await page.locator("#assessmentSetup .assessment-applied").waitFor();
        await page.locator("#assessmentSetup input[type=checkbox]:not(:disabled)").waitFor();
        return page.locator("#assessmentSetup");
    }
    let pane = await settings();
    await pane.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true }).check();
    const enableResponse = page.waitForResponse(response => response.url().endsWith("/api/assessment/consent/set"));
    await pane.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    assert.equal((await enableResponse).status(), 200);
    await page.waitForFunction(() => document.querySelector("#assessmentSetup")?.textContent.includes("Response saving is on."));
    const originalGrant = (await loadBoardState(context)).personalEvaluation.consent;
    await appendFile(a.file, jsonl([event("assistant.message", { content: "ARTIFICIAL_OLD_SOURCE_RESPONSE" })]));
    await runtime.collector.collectNow();
    let state = await loadBoardState(context);
    const oldCapture = state.personalEvaluation.captures[0];
    assert.ok(oldCapture);
    const priorScenario = state.evidence.find(record => record.sourceSessionId === a.sourceId).scenarioId;
    await page.goto(runtime.url + "#request?request=" + encodeURIComponent(priorScenario)); await ready(page);
    await page.getByRole("button", { name: "Read response", exact: true }).click();
    await page.locator(".interaction-response pre").waitFor();
    assert.equal(await page.locator(".interaction-response pre").textContent(), "ARTIFICIAL_OLD_SOURCE_RESPONSE");
    const beforeSave = await loadBoardState(context);
    const preview = await reports.preview("synthetic-retained-copy", undefined, { promptMode: "none", formats: ["json"] }, { kind: "selected", revision: beforeSave.revision, scenarioIds: [priorScenario] });
    await reports.review("synthetic-retained-copy", preview.previewId, true);
    const saved = (await reports.confirm("synthetic-retained-copy", preview.previewId, true)).bundle;
    const frozen = await Promise.all(Object.values(saved.files).map(async file => [file, hash(await readFile(file))]));
    async function unchangedGrant(label) {
        pane = await settings();
        assert.match(await pane.locator(".assessment-applied").textContent(), /Response saving is on/, label);
        assert.equal(await pane.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false, label);
        assert.equal(await pane.getByRole("button", { name: "Remove previously saved responses", exact: true }).isVisible(), false, label);
        assert.deepEqual((await loadBoardState(context)).personalEvaluation.consent, originalGrant, label);
        assert.equal(calls.filter(call => call.path.endsWith("/consent/set")).length, 1, label);
    }
    await page.goto(runtime.url + "#home?range=7&service=Mail&result=success"); await ready(page);
    await unchangedGrant("Ordinary view filters are not capture scope.");
    await page.goto(runtime.url + "#settings?section=display"); await ready(page);
    await selectActivityOption(page, "displayTimeZone", "UTC"); await ready(page);
    await unchangedGrant("Display time zone is not capture scope.");
    const poll = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal((await poll).status(), 200);
    await unchangedGrant("Routine polling does not require renewed permission.");
    await appendFile(a.file, jsonl([...interaction("same-source-next"), event("assistant.message", { content: "ARTIFICIAL_SAME_SOURCE_NEXT_RESPONSE" })]));
    await runtime.collector.collectNow();
    assert.equal((await loadBoardState(context)).personalEvaluation.captures.length, 2);
    await unchangedGrant("New in-scope activity remains covered by the unchanged explicit grant.");
    await runtime.collector.configure(b.config);
    await runtime.collector.collectNow();
    await appendFile(b.file, jsonl([event("assistant.message", { content: "ARTIFICIAL_BLOCKED_BEFORE_RENEWAL" })]));
    await runtime.collector.collectNow();
    state = await loadBoardState(context);
    const changedSource = runtime.collector.assessmentSource(state);
    assert.notEqual(changedSource.sourceConfigRef, originalGrant.sourceConfigRef);
    assert.equal(state.personalEvaluation.captures.some(capture => capture.observation.captureContext.sourceConfigRef === changedSource.sourceConfigRef), false);
    const current = buildAssessmentModel(state, { source: changedSource });
    await assert.rejects(executeAssessmentAction(context, "synthetic-read-check", "get_interaction_evidence", {
        schemaVersion: 1, interactionRef: oldCapture.observation.interactionRef,
        observationRef: oldCapture.observation.observationRef, expectedBasis: current.basis,
    }, { source: value => runtime.collector.assessmentSource(value) }), error => error.status === 403 || error.status === 404);
    const baseBeforeRenewal = structuredClone(state.evidence);
    pane = await settings();
    assert.match(await pane.locator(".assessment-applied").textContent(), /inactive.*source changed/i);
    const checkbox = pane.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true });
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(calls.filter(call => call.path.endsWith("/consent/set")).length, 1);
    await checkbox.check();
    assert.equal(await pane.getByText(/Enabling capture for this source removes prior optional response evidence/).isVisible(), true);
    const renewalResponse = page.waitForResponse(response => response.url().endsWith("/api/assessment/consent/set"));
    await pane.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    const renewed = await renewalResponse;
    assert.equal(renewed.status(), 200, await renewed.text());
    await page.waitForFunction(() => document.querySelector("#assessmentSetup")?.textContent.includes("Response saving is on."));
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.consent.sourceConfigRef, changedSource.sourceConfigRef);
    assert.equal(state.personalEvaluation.captures.length, 0, "Renewal cleans older optional epochs.");
    assert.deepEqual(state.evidence, baseBeforeRenewal, "Renewal preserves base activity.");
    for (const [file, expected] of frozen) assert.equal(hash(await readFile(file)), expected, "Renewal preserves saved report bytes.");
    await appendFile(b.file, jsonl([event("assistant.message", { content: "ARTIFICIAL_RENEWED_SOURCE_RESPONSE" })]));
    await runtime.collector.collectNow();
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.captures.length, 1);
    assert.equal(state.personalEvaluation.captures[0].observation.captureContext.sourceConfigRef, changedSource.sourceConfigRef);
    const nextScenario = state.evidence.find(record => record.sourceSessionId === b.sourceId).scenarioId;
    await page.goto(runtime.url + "#request?request=" + encodeURIComponent(nextScenario)); await ready(page);
    await page.getByRole("button", { name: "Read response", exact: true }).click();
    await page.locator(".interaction-response pre").waitFor();
    assert.equal(await page.locator(".interaction-response pre").textContent(), "ARTIFICIAL_RENEWED_SOURCE_RESPONSE");
    assert.equal(calls.filter(call => call.path.endsWith("/consent/set")).length, 2, "Only the original explicit grant and explicit renewal mutate permission.");
});
