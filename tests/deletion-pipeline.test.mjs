import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { buildAssessmentModel, finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createExportController } from "../lib/export.mjs";
import { deletionHash } from "../lib/deletion-identities.mjs";

test("real range purge follows source call dates through capture, feedback, report review, rotation and restart", { timeout: 20000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-deletion-pipeline-"));
    const context = { dataDir: path.join(root, "private") }, sourceId = randomUUID(), dbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Synthetic source-date deletion", "chat", null, "local");
    const firstDay = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const secondDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const laterDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const event = (id, type, timestamp, data) => ({ id, type, timestamp, data });
    const call = (id, day) => event(`start-${id}`, "tool.execution_start", `${day}T12:00:00.000Z`,
        { toolCallId: id, toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", arguments: { entityUrls: ["/me/messages"] } });
    const events = [
        event("startup", "session.start", `${firstDay}T10:00:00.000Z`, { sessionId: sourceId, version: 1 }),
        event("prompt", "user.message", `${firstDay}T11:00:00.000Z`, { content: "SYNTHETIC_SHARED_REQUEST" }),
        call("delete-A", firstDay), call("preserve-B", secondDay),
        event("complete-B", "tool.execution_complete", `${secondDay}T12:00:01.000Z`, { toolCallId: "preserve-B", success: true }),
    ];
    const jsonl = values => values.map(value => JSON.stringify(value) + "\n").join("");
    const file = path.join(sessionRoot, sourceId, "events.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, jsonl(events));
    let collector = await createCollector(context, { timers: false });
    t.after(async () => { await collector.close(); db.close(); await rm(root, { recursive: true, force: true }); });
    const config = { appDbPath: dbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await collector.configure(config);
    await collector.collectNow();
    let state = await loadBoardState(context);
    const source = collector.assessmentSource(state);
    await executeAssessmentAction(context, "panel", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, expectedSourceRevision: state.evidenceRevision,
        expectedConsentRevision: 0, policyVersion: 1, enabled: true, categories: ["answer"], sourceConfigRef: source.sourceConfigRef,
        sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    }, { source: current => collector.assessmentSource(current) });
    const answer = event("old-answer", "assistant.message", `${laterDay}T12:00:00.000Z`, { content: "SYNTHETIC_LATE_SHARED_ANSWER" });
    await appendFile(file, jsonl([answer]));
    await collector.collectNow();
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.captures.length, 1);
    for (const verdict of ["pass", "fail"]) {
        state = await loadBoardState(context);
        const model = buildAssessmentModel(state);
        await executeAssessmentAction(context, "panel", "set_personal_assessment", {
            schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: model.overview.interactionRefs[0],
            expectedBasis: model.basis, checkId: "semantic-answer-correctness", verdict, withdraw: false,
        });
    }
    const reports = createExportController(context);
    state = await loadBoardState(context);
    const savedPreview = await reports.preview("report", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: state.revision });
    await reports.review("report", savedPreview.previewId, true);
    const saved = (await reports.confirm("report", savedPreview.previewId, true)).bundle;
    const savedHashes = await Promise.all(Object.values(saved.files).map(async name => deletionHash(await readFile(name))));
    state = await loadBoardState(context);
    const stale = await reports.preview("stale", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: state.revision });
    await reports.review("stale", stale.previewId, true);
    const sourceHash = deletionHash(await readFile(file)), dbHash = deletionHash(await readFile(dbPath));
    const retainedCall = state.evidence[0].toolCalls.find(call => call.toolCallId === "preserve-B");
    const deletion = createDeletionController(context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup, onSeal: () => reports.invalidateDerived() });
    const preview = await deletion.preview("panel", { scope: "range", from: firstDay, to: firstDay, timeContext: { timeZone: "UTC", locale: "en-US" } });
    assert.equal(preview.counts.records, 1);
    assert.equal(preview.counts.partialGroups, 1);
    assert.equal(preview.linkedInsights.capturedItems, 1);
    assert.equal(preview.linkedInsights.feedbackRevisions, 2);
    await deletion.confirm("panel", { operationId: preview.operationId, confirmed: true });
    state = await loadBoardState(context);
    assert.deepEqual(state.evidence[0].toolCalls, [retainedCall]);
    assert.equal(state.evidence[0].assessmentMembershipPruned, true);
    assert.deepEqual(state.personalEvaluation.captures, []);
    assert.deepEqual(state.personalEvaluation.feedback.records, []);
    assert.deepEqual(await readdir(path.join(context.dataDir, "assessment-evidence")), []);
    assert.equal(deletionHash(await readFile(file)), sourceHash);
    assert.equal(deletionHash(await readFile(dbPath)), dbHash);
    await assert.rejects(reports.confirm("stale", stale.previewId, true), /Preview|changed/);
    const late = event("late-A", "tool.execution_complete", `${laterDay}T12:01:00.000Z`, { toolCallId: "delete-A", success: true });
    await writeFile(file, jsonl([{ ...events[0], id: "rotated-startup" }, ...events.slice(1), answer, late]));
    await collector.configure({ ...config, windowDays: 90 });
    const changed = await loadBoardState(context), changedSource = collector.assessmentSource(changed);
    await executeAssessmentAction(context, "panel", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, expectedSourceRevision: changed.evidenceRevision,
        expectedConsentRevision: changed.personalEvaluation.consent.revision, policyVersion: 1, enabled: true, categories: ["answer"],
        sourceConfigRef: changedSource.sourceConfigRef, sourceConfigRevision: changedSource.sourceConfigRevision, confirmed: true,
    }, { source: current => collector.assessmentSource(current), commitCaptureRevocation: deletion.commitCaptureRevocation });
    await collector.collectNow();
    await collector.close();
    collector = await createCollector(context, { timers: false });
    await collector.collectNow();
    state = await loadBoardState(context);
    assert.deepEqual(state.evidence.flatMap(record => record.toolCalls.map(call => call.toolCallId)), ["preserve-B"]);
    assert.equal(state.personalEvaluation.captures.length, 0, "Old shared answer cannot return after source rotation");
    await appendFile(file, jsonl([
        call("fresh-C", laterDay),
        event("fresh-answer", "assistant.message", `${laterDay}T12:02:00.000Z`, { content: "SYNTHETIC_NEW_SHARED_ANSWER" }),
    ]));
    await collector.collectNow();
    state = await loadBoardState(context);
    assert.deepEqual(new Set(state.evidence.flatMap(record => record.toolCalls.map(call => call.toolCallId))), new Set(["preserve-B", "fresh-C"]));
    assert.equal(state.personalEvaluation.captures.length, 1);
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async name => deletionHash(await readFile(name)))), savedHashes);
});
