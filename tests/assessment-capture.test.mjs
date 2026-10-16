import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState, exclusiveBoard } from "../lib/store.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { buildAssessmentModel, assessmentBasis, assessmentDependencies, assessmentRef } from "../lib/assessment-read-model.mjs";
import { assessmentHash } from "../lib/assessment-read-model.mjs";
import { finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { selectPersonalEvaluationCleanup, defaultPersonalEvaluation, validatePersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { inspectComparisonPair } from "../lib/comparison-export.mjs";

function invalidJsonPaths(value, prefix = "$", parents = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return [];
    if (!value || typeof value !== "object" || parents.has(value)
        || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return [prefix];
    parents.add(value);
    const paths = Object.entries(value).flatMap(([key, child]) => invalidJsonPaths(child, `${prefix}.${key}`, parents));
    parents.delete(value);
    return paths;
}

// Invented pre-retirement state, not a current product write path.
async function seedHistoricalFeedback(context, input) {
    return exclusiveBoard(context, async (state, save) => {
        const view = buildAssessmentModel(state).details.get(input.interactionRef);
        assert.deepEqual(view.basis, input.expectedBasis);
        state.personalEvaluation ??= defaultPersonalEvaluation();
        const personal = state.personalEvaluation;
        const previous = personal.feedback.records.filter(item => item.assessment.interactionRef === input.interactionRef
            && item.assessment.checkId === input.checkId).at(-1)?.assessment;
        personal.overrideRevision++; personal.feedback.revision++;
        const basis = assessmentBasis(state), assessment = {
            schemaVersion: 1, interactionRef: input.interactionRef, basis, createdAt: new Date().toISOString(),
            evidenceRefs: [...new Set(view.observations.flatMap(item => item.evidenceRefs))],
            assessmentRef: assessmentRef(state, "assessment", [input.mutationRef, input.checkId]), checkId: input.checkId, checkVersion: 1,
            dimension: { "semantic-answer-correctness": "accuracy", "answer-support-validity": "answer-trust",
                "action-authorization-compliance": "action-trust" }[input.checkId],
            unitRef: input.interactionRef, origin: "user-personal", rubricVersion: 1, verdict: input.verdict, reason: "user-verdict",
            revision: (previous?.revision ?? 0) + 1, supersedes: previous?.assessmentRef ?? null, withdrawn: false,
        };
        const dependencies = { ...assessmentDependencies(view), basis };
        personal.feedback.records.push({ schemaVersion: 1, assessment, dependencies });
        personal.mutations[input.mutationRef] = {
            ownerHash: assessmentHash(["assessment-owner", "owner"]), inputHash: assessmentHash(["set_personal_assessment", input]), dependencies,
            receipt: { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete", basis, data: { assessment } },
        };
        validatePersonalEvaluation(personal);
        state.revision++; await save(state);
    });
}

test("synthetic: collector, consent, historical annotations, frozen reports and deletion remain consistent", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-assessment-synthetic-"));
    const dbPath = path.join(root, "data.db"), sourceRoot = path.join(root, "session-state"), sourceId = randomUUID();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Synthetic", "chat", null, "local");
    await mkdir(path.join(sourceRoot, sourceId), { recursive: true });
    const file = path.join(sourceRoot, sourceId, "events.jsonl"), context = { dataDir: path.join(root, "private") };
    const event = (type, data, id = randomUUID()) => ({ id, type, timestamp: new Date().toISOString(), data });
    await writeFile(file, [
        event("session.start", { sessionId: sourceId, version: 1 }), event("user.message", { content: "Artificial request" }, "prompt"),
        event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: "call", arguments: { entityUrls: ["/me/messages"] } }),
        event("tool.execution_complete", { toolCallId: "call", success: true }),
        event("assistant.message", { content: "OFF_NOT_CAPTURED_SYNTHETIC" }),
    ].map(e => JSON.stringify(e) + "\n").join(""));
    let collector = await createCollector(context, { timers: false }), runtime;
    t.after(async () => { if (runtime) await runtime.close(); else await collector.close(); db.close(); await rm(root, { recursive: true, force: true }); });
    await collector.configure({ appDbPath: dbPath, sessionRoot: sourceRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    let state = await loadBoardState(context);
    assert.equal(state.personalEvaluation, undefined);
    assert.equal(state.evidence.length, 1, "The supported synthetic source must actually be imported before capture setup");
    const baseModel = buildAssessmentModel(state);
    await seedHistoricalFeedback(context, {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: baseModel.overview.interactionRefs[0],
        expectedBasis: baseModel.basis, checkId: "action-authorization-compliance", verdict: "pass", withdraw: false,
    });
    const source = collector.assessmentSource(state);
    const consent = await executeAssessmentAction(context, "owner", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, expectedSourceRevision: state.evidenceRevision,
        expectedConsentRevision: 0, policyVersion: 1, enabled: true, categories: ["answer"],
        sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    }, { source: state => collector.assessmentSource(state) });
    assert.equal(consent.data.consent.state, "enabled");
    await appendFile(file, JSON.stringify(event("assistant.message", { content: "ON_CAPTURED_SYNTHETIC_ANSWER" })) + "\n");
    const collected = await collector.collectNow();
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.captures.length, 1, JSON.stringify({
        counts: collected.metrics.assessmentCapture, errors: collected.cursors.map(row => row.errorCode),
        linkedMessages: state.evidence.map(record => record.userPrompt?.sourceEventId),
    }));
    const capture = state.personalEvaluation.captures[0], model = buildAssessmentModel(state);
    assert.ok(![...model.details.values()][0].assessments.some(value => value.origin === "user-personal"),
        "Historical personal verdicts are not exposed in current projections.");
    const answer = await executeAssessmentAction(context, "owner", "get_interaction_evidence", {
        schemaVersion: 1, interactionRef: capture.observation.interactionRef, observationRef: capture.observation.observationRef, expectedBasis: model.basis,
    });
    assert.equal(answer.data.text, "ON_CAPTURED_SYNTHETIC_ANSWER");
    assert.doesNotMatch(JSON.stringify(state), /ON_CAPTURED_SYNTHETIC_ANSWER|OFF_NOT_CAPTURED_SYNTHETIC/);
    const index = JSON.parse(await readFile(path.join(context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = await readFile(path.join(context.dataDir, "collector", index.fingerprint, `${sourceId}.json`), "utf8");
    assert.doesNotMatch(checkpoint, /ON_CAPTURED_SYNTHETIC_ANSWER|OFF_NOT_CAPTURED_SYNTHETIC/);
    await appendFile(file, JSON.stringify(event("assistant.message", { content: "password=synthetic-test-value" })) + "\n");
    const excluded = await collector.collectNow();
    assert.equal(excluded.metrics.assessmentCapture.excluded, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.captures.length, 1);
    const beforeBounded = await loadBoardState(context);
    await appendFile(file, JSON.stringify(event("assistant.message", { content: "x".repeat(65540) })) + "\n");
    await collector.collectNow();
    const afterBounded = await loadBoardState(context), bounded = afterBounded.personalEvaluation.captures.at(-1);
    assert.equal(bounded.observation.payload.utf8Bytes, 65536);
    assert.equal(bounded.observation.payload.completeness, "bounded-fragment");
    assert.equal(afterBounded.evidenceRevision, beforeBounded.evidenceRevision + 1, "A new response advances evidence even without another tool call");
    assert.deepEqual(afterBounded.evidence.flatMap(record => record.toolCalls), beforeBounded.evidence.flatMap(record => record.toolCalls));
    const feedbackInputs = [];
    for (const verdict of ["pass", "fail"]) {
        const current = await loadBoardState(context), view = buildAssessmentModel(current);
        const input = {
            schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: view.overview.interactionRefs[0],
            expectedBasis: view.basis, checkId: "semantic-answer-correctness", verdict, withdraw: false,
        };
        await seedHistoricalFeedback(context, input);
        feedbackInputs.push(input);
    }
    const reports = createExportController(context);
    async function saveReport(formats) {
        const current = await loadBoardState(context);
        const preview = await reports.preview("owner", undefined, { promptMode: "none", formats }, { kind: "all", revision: current.revision });
        await reports.review("owner", preview.previewId, true);
        return (await reports.confirm("owner", preview.previewId, true)).bundle;
    }
    const baseline = await saveReport(["json", "html", "markdown"]), later = await saveReport(["pdf"]);
    const pair = await inspectComparisonPair(context, await loadBoardState(context), baseline.bundleId, later.bundleId);
    assert.deepEqual(invalidJsonPaths([pair.sourceFacts, pair.comparison]), [], "Frozen comparison projection must contain only explicit JSON values");
    const comparisonPreview = await reports.previewComparison("owner", baseline.bundleId, later.bundleId, { formats: ["json"] });
    await reports.reviewComparison("owner", comparisonPreview.previewId, true);
    const comparison = (await reports.confirmComparison("owner", comparisonPreview.previewId, true)).bundle;
    const frozenFiles = [baseline, later, comparison].flatMap(bundle => Object.values(bundle.files));
    const frozenHashes = await Promise.all(frozenFiles.map(async file => assessmentHash(await readFile(file))));
    state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.feedback.records.length, 3);
    const sourceBytes = await readFile(file);
    const deletion = createDeletionController(context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup, onSeal: () => reports.invalidateDerived() });
    const revoked = await executeAssessmentAction(context, "owner", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, expectedSourceRevision: state.evidenceRevision,
        expectedConsentRevision: state.personalEvaluation.consent.revision, policyVersion: 1, enabled: false, categories: [],
        sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    }, { source: state => collector.assessmentSource(state), commitCaptureRevocation: deletion.commitCaptureRevocation });
    assert.equal(revoked.phase, "complete");
    const afterRevocation = await loadBoardState(context);
    assert.equal(afterRevocation.personalEvaluation.consent.state, "revoked");
    assert.equal(afterRevocation.personalEvaluation.captures.length, 0);
    assert.equal(afterRevocation.personalEvaluation.feedback.records.length, 1);
    const restoredBase = [...buildAssessmentModel(afterRevocation).details.values()][0].assessments.filter(value => value.origin === "user-personal");
    assert.deepEqual(restoredBase, [], "Privacy cleanup never reactivates a retired rating lane.");
    assert.deepEqual(afterRevocation.personalEvaluation.feedback.records.map(item => [item.assessment.checkId, item.assessment.verdict]),
        [["action-authorization-compliance", "pass"]], "The unrelated historical base-only opinion is still retained.");
    assert.deepEqual(afterRevocation.evidence, state.evidence);
    assert.deepEqual(afterRevocation.deletion.identities, []);
    assert.deepEqual(await Promise.all(frozenFiles.map(async file => assessmentHash(await readFile(file)))), frozenHashes);
    assert.deepEqual(await readFile(file), sourceBytes);
    await assert.rejects(executeAssessmentAction(context, "owner", "set_personal_assessment", feedbackInputs[0]),
        error => error.code === "PERSONAL_FEEDBACK_RETIRED");
    assert.equal((await executeAssessmentAction(context, "owner", "get_mutation_status", {
        schemaVersion: 1, mutationRef: feedbackInputs[0].mutationRef,
    })).phase, "purged");
    await collector.close();
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    collector = runtime.collector;
    const origin = runtime.url.slice(0, -1);
    const post = (route, body, capability) => fetch(origin + route, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const capability = (await (await post("/api/session", {})).json()).capability;
    async function configureCapture(enabled) {
        const settings = await (await post("/api/assessment/consent", { schemaVersion: 1 }, capability)).json();
        const response = await post("/api/assessment/consent/set", {
            schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, expectedSourceRevision: settings.basis.sourceRevision,
            expectedConsentRevision: settings.data.consent.revision, policyVersion: 1, enabled, categories: enabled ? ["answer"] : [],
            sourceConfigRef: settings.data.source.sourceConfigRef, sourceConfigRevision: settings.data.source.sourceConfigRevision, confirmed: true,
        }, capability);
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    }
    await configureCapture(true);
    await appendFile(file, JSON.stringify(event("assistant.message", { content: "HTTP_SYNTHETIC_ANSWER" })) + "\n");
    await collector.collectNow();
    assert.equal((await loadBoardState(context)).personalEvaluation.captures.length, 1);
    assert.equal((await configureCapture(false)).phase, "complete");
    assert.equal((await loadBoardState(context)).personalEvaluation.captures.length, 0);
    await configureCapture(true);
    await appendFile(file, JSON.stringify(event("assistant.message", { content: "ALL_PURGE_SYNTHETIC_ANSWER" })) + "\n");
    await collector.collectNow();
    const collectedState = await loadBoardState(context), collectedModel = buildAssessmentModel(collectedState);
    const interactionRef = collectedModel.overview.interactionRefs[0];
    const historicalInput = {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef,
        expectedBasis: collectedModel.basis, checkId: "answer-support-validity", verdict: "fail", withdraw: false,
    };
    await seedHistoricalFeedback(context, historicalInput);
    const feedbackResponse = await post("/api/assessment/feedback", historicalInput, capability);
    assert.equal(feedbackResponse.status, 410, await feedbackResponse.clone().text());
    const beforeAllSource = await readFile(file);
    const deletionPreview = await (await post("/api/deletion/preview", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } }, capability)).json();
    const committed = await post("/api/deletion/confirm", { operationId: deletionPreview.operationId, confirmed: true }, capability);
    assert.equal(committed.status, 200, await committed.clone().text());
    const afterAll = await loadBoardState(context);
    assert.equal(afterAll.evidence.length, 0);
    assert.equal(afterAll.evidenceRevision, collectedState.evidenceRevision + 1);
    assert.equal(afterAll.personalEvaluation.captures.length, 0);
    assert.equal(afterAll.personalEvaluation.feedback.records.length, 0);
    assert.equal(afterAll.personalEvaluation.consent.state, "enabled", "Activity deletion preserves consent/configuration; it is not revocation");
    assert.equal(afterAll.exports.length, 3);
    assert.deepEqual(await Promise.all(frozenFiles.map(async file => assessmentHash(await readFile(file)))), frozenHashes);
    assert.deepEqual(await readFile(file), beforeAllSource);
    assert.equal((await post("/api/assessment/detail", { schemaVersion: 1, interactionRef, expectedSourceRevision: afterAll.evidenceRevision }, capability)).status, 404);
    await appendFile(file, [
        event("user.message", { content: "New artificial interaction after All" }, "fresh-prompt"),
        event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: "fresh-call", arguments: { entityUrls: ["/me/messages"] } }),
        event("tool.execution_complete", { toolCallId: "fresh-call", success: true }),
        event("assistant.message", { content: "NEW_SURVIVING_SYNTHETIC_RESPONSE" }),
    ].map(value => JSON.stringify(value) + "\n").join(""));
    await collector.collectNow();
    const freshState = await loadBoardState(context), freshModel = buildAssessmentModel(freshState);
    assert.equal(freshState.evidence.length, 1);
    assert.equal(freshState.personalEvaluation.captures.length, 1);
    assert.equal((await post("/api/assessment/feedback", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: freshModel.overview.interactionRefs[0],
        expectedBasis: freshModel.basis, checkId: "semantic-answer-correctness", verdict: "pass", withdraw: false,
    }, capability)).status, 410);
    const stalePreviewResponse = await post("/api/report-comparison/preview", {
        baselineId: baseline.bundleId, laterId: later.bundleId, formats: ["json"],
    }, capability);
    assert.equal(stalePreviewResponse.status, 200, await stalePreviewResponse.clone().text());
    const stalePreview = await stalePreviewResponse.json();
    assert.equal((await post("/api/report-comparison/review", { previewId: stalePreview.previewId, disclosureReviewed: true }, capability)).status, 200);
    const beforeObject = await loadBoardState(context), sourceBeforeObject = await readFile(file);
    const survivorFiles = [later, comparison].flatMap(bundle => Object.values(bundle.files));
    const survivorHashes = await Promise.all(survivorFiles.map(async file => assessmentHash(await readFile(file))));
    const objectPreviewResponse = await post("/api/artifact-deletion/preview", { artifactKind: "report", artifactId: baseline.bundleId }, capability);
    assert.equal(objectPreviewResponse.status, 200, await objectPreviewResponse.clone().text());
    const objectPreview = await objectPreviewResponse.json();
    assert.equal(objectPreview.counts.savedDependentComparisons, 1);
    const objectConfirmed = await post("/api/artifact-deletion/confirm", { operationId: objectPreview.operationId, confirmed: true }, capability);
    assert.equal(objectConfirmed.status, 200, await objectConfirmed.clone().text());
    const afterObject = await loadBoardState(context);
    assert.equal(afterObject.exports.length, 2);
    assert.equal(afterObject.evidenceRevision, beforeObject.evidenceRevision);
    assert.deepEqual(afterObject.evidence, beforeObject.evidence);
    assert.deepEqual(afterObject.personalEvaluation, beforeObject.personalEvaluation);
    assert.deepEqual(await readFile(file), sourceBeforeObject);
    assert.deepEqual(await Promise.all(survivorFiles.map(async file => assessmentHash(await readFile(file)))), survivorHashes);
    for (const target of Object.values(baseline.files)) await assert.rejects(readFile(target), error => error.code === "ENOENT");
    assert.equal((await post("/api/report-file", { bundleId: baseline.bundleId, name: "product-report.json" }, capability)).status, 404);
    assert.ok([409, 410].includes((await post("/api/report-comparison/save", { previewId: stalePreview.previewId, confirmed: true }, capability)).status));
    const opened = await (await post("/api/report-comparison/open", { bundleId: comparison.bundleId }, capability)).json();
    assert.equal(opened.sources[0].available, false);
    assert.equal(opened.sources[1].available, true);
    const other = (await (await post("/api/session", {})).json()).capability;
    assert.equal((await post("/api/artifact-deletion/status", { operationId: objectPreview.operationId }, other)).status, 403);
    assert.equal((await post("/api/artifact-deletion/status", { operationId: objectPreview.operationId, receiptToken: objectPreview.receiptToken }, other)).status, 200);
    assert.equal((await post("/api/artifact-deletion/confirm", { operationId: objectPreview.operationId, confirmed: true }, other)).status, 403);
    const comparisonDeleteResponse = await post("/api/artifact-deletion/preview", { artifactKind: "comparison", artifactId: comparison.bundleId }, capability);
    assert.equal(comparisonDeleteResponse.status, 200, await comparisonDeleteResponse.clone().text());
    const comparisonDelete = await comparisonDeleteResponse.json();
    assert.equal((await post("/api/artifact-deletion/confirm", { operationId: comparisonDelete.operationId, confirmed: true }, capability)).status, 200);
    const finalState = await loadBoardState(context);
    assert.deepEqual(finalState.exports.map(bundle => bundle.bundleId), [later.bundleId]);
    assert.deepEqual(finalState.evidence, beforeObject.evidence);
    assert.deepEqual(finalState.personalEvaluation, beforeObject.personalEvaluation);
    assert.equal((await post("/api/report-comparison/open", { bundleId: comparison.bundleId }, capability)).status, 404);
    for (const target of Object.values(comparison.files)) await assert.rejects(readFile(target), error => error.code === "ENOENT");
});
