import test from "node:test";
import assert from "node:assert/strict";
import { readFile, appendFile, rename, writeFile, readdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { createRecollectionController } from "../lib/recollection.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { callIdentity, deletionHash, eventIdentity, filterDeletedEvents } from "../lib/deletion-identities.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { buildAssessmentModel, finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";

const scope = f => ({ sourceSessionIds: [f.sourceId], from: f.firstDay, to: f.firstDay,
    restorePrompts: false, timeContext: { timeZone: "UTC", locale: "en-US" } });
async function remove(f) {
    const controller = createDeletionController(f.context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup });
    const preview = await controller.preview("panel", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
}
const ids = state => state.evidence.flatMap(record => record.toolCalls.map(call => call.toolCallId));
const hashes = files => Promise.all(files.map(async file => deletionHash(await readFile(file))));

test("preview/cancel do not mutate; confirm rereads exact selected source identities and preserves reports/suppression on restart", async t => {
    const f = await recollectionFixture(t);
    const reports = createExportController(f.context);
    const state = await loadBoardState(f.context);
    const preview = await reports.preview("report", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: state.revision });
    await reports.review("report", preview.previewId, true);
    const bundle = (await reports.confirm("report", preview.previewId, true)).bundle;
    const protectedFiles = [...f.files, f.dbPath, ...Object.values(bundle.files)];
    const beforeHashes = await hashes(protectedFiles);
    await remove(f);
    const empty = await loadBoardState(f.context);
    const privateFiles = async () => (await readdir(f.context.dataDir, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
    const beforeFiles = await privateFiles(), beforeBytes = await hashes(beforeFiles);
    const controller = createRecollectionController(f.context);
    let candidate = await controller.preview("panel", scope(f));
    assert.equal(candidate.counts.records, 1);
    assert.equal(candidate.counts.reauthorized, 1);
    assert.equal(candidate.counts.restoredPrompts, 0);
    await assert.rejects(controller.confirm("other-panel", { operationId: candidate.operationId, confirmed: true }), /unavailable/);
    controller.cancel("panel", { operationId: candidate.operationId });
    assert.deepEqual(await loadBoardState(f.context), empty);
    assert.deepEqual(await privateFiles(), beforeFiles);
    assert.deepEqual(await hashes(beforeFiles), beforeBytes);
    await assert.rejects(controller.confirm("panel", { operationId: candidate.operationId, confirmed: true }), /unavailable/);
    candidate = await controller.preview("panel", scope(f));
    const result = await controller.confirm("panel", { operationId: candidate.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    let collected = await loadBoardState(f.context);
    assert.deepEqual(ids(collected), ["selected-A"]);
    assert.equal(collected.evidence[0].userPrompt.text, null);
    assert.equal(collected.evidence[0].toolCalls[0].recollection.previouslyDeleted, true);
    assert.ok(collected.deletion.identities.includes(callIdentity(f.sourceId, "outside-B")));
    assert.ok(collected.deletion.identities.includes(callIdentity(f.otherSourceId, "outside-C")));
    assert.deepEqual(collected.deletion.events, empty.deletion.events);
    assert.deepEqual(collected.deletion.contextCalls, empty.deletion.contextCalls);
    const payload = await currentStatePayload(f.context, collected);
    assert.equal(payload.exportCatalog.requests.length, 1);
    assert.equal(payload.scenarios.flatMap(row => row.toolCalls).length, 1);
    assert.equal(payload.coverage.counts.includedCalls, 1);
    assert.equal(payload.assessment.overview.interactionRefs.length, 1);
    await f.collector.collectNow();
    await f.restart();
    await f.collector.collectNow();
    collected = await loadBoardState(f.context);
    assert.deepEqual(ids(collected), ["selected-A"]);
    assert.deepEqual(await hashes(protectedFiles), beforeHashes);
    const receipt = await createRecollectionController(f.context).status("new-panel", { operationId: result.operationId, receiptToken: candidate.receiptToken });
    assert.equal(receipt.phase, "complete");
    await assert.rejects(controller.status("unrelated", { operationId: result.operationId }), /not authorized/);
    assert.deepEqual(ids(await loadBoardState(f.context)), ["selected-A"]);
});

test("separate prompt opt-in is selected-unit-only, can follow base recollection, and is revoked by subsequent deletion", async t => {
    const f = await recollectionFixture(t);
    await remove(f);
    const controller = createRecollectionController(f.context);
    let preview = await controller.preview("panel", scope(f));
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    preview = await controller.preview("panel", { ...scope(f), restorePrompts: true });
    assert.equal(preview.counts.promptOnly, 1);
    assert.equal(preview.counts.newRecords, 0);
    assert.ok(preview.counts.restoredPrompts >= 1);
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    let state = await loadBoardState(f.context);
    assert.equal(state.evidence[0].userPrompt.text, "Synthetic request selected-A");
    const grant = state.deletion.promptAuthorizations[eventIdentity(f.sourceId, "prompt-selected-A")];
    assert.ok(grant.includes(callIdentity(f.sourceId, "selected-A")));
    assert.ok(!grant.includes(callIdentity(f.sourceId, "outside-B")));
    assert.deepEqual(filterDeletedEvents([{ id: "prompt-selected-A", type: "user.message", data: { content: "secret" } }], f.sourceId, state.deletion)[0].data, { content: null });
    await f.restart(); await f.collector.collectNow();
    assert.equal((await loadBoardState(f.context)).evidence[0].userPrompt.text, "Synthetic request selected-A");
    await remove(f);
    state = await loadBoardState(f.context);
    assert.deepEqual(ids(state), []);
    assert.deepEqual(state.deletion.promptAuthorizations, {});
    preview = await createRecollectionController(f.context).preview("panel", scope(f));
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /unavailable/);
});

test("stale source, settings, preview expiry and unconfirmed requests cannot authorize recollection", async t => {
    const f = await recollectionFixture(t);
    await remove(f);
    let clock = Date.now();
    const controller = createRecollectionController(f.context, { now: () => clock });
    let preview = await controller.preview("panel", scope(f));
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: false }), /confirmation/);
    await appendFile(f.files[0], "\n");
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /history.*changed/);
    preview = await controller.preview("panel", scope(f));
    clock += 120001;
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /preview changed/);
    clock = Date.now();
    preview = await controller.preview("panel", scope(f));
    await f.collector.setEnabled(true);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /approval.*changed/);
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("missing and unsupported source history is disclosed, not a fake successful restoration", async t => {
    const f = await recollectionFixture(t);
    await remove(f);
    await rename(f.files[0], f.files[0] + ".missing");
    const controller = createRecollectionController(f.context);
    const sources = await controller.sources();
    assert.equal(sources.sources.find(row => row.sourceSessionId === f.sourceId).available, false);
    const preview = await controller.preview("panel", scope(f));
    assert.equal(preview.counts.records, 0);
    assert.match(preview.availability[0].problem, /unavailable/);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /No available/);
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
    const unsupported = (await readFile(f.files[0] + ".missing", "utf8")).trim().split("\n").map(JSON.parse);
    unsupported[0].data.version = 999;
    await writeFile(f.files[0], unsupported.map(row => JSON.stringify(row) + "\n").join(""));
    const invalid = await controller.preview("panel", scope(f));
    assert.equal(invalid.counts.records, 0);
    assert.match(invalid.availability[0].problem, /identity\/schema/);
    await assert.rejects(controller.confirm("panel", { operationId: invalid.operationId, confirmed: true }), /No available/);
});

test("failed atomic publication never relaxes suppression or replays on restart", async t => {
    const f = await recollectionFixture(t);
    await remove(f);
    const before = await loadBoardState(f.context);
    const controller = createRecollectionController(f.context, { beforeSave: () => { throw new Error("synthetic write interruption"); } });
    const preview = await controller.preview("panel", { ...scope(f), restorePrompts: true });
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /write interruption/);
    assert.deepEqual(await loadBoardState(f.context), before);
    await f.restart();
    assert.equal((await createRecollectionController(f.context).status("panel", { operationId: preview.operationId, receiptToken: preview.receiptToken })).phase, "not-started");
    await f.collector.collectNow();
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
    await remove(f);
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("shared prompt permission cannot leak onto an out-of-scope reimport or survive deletion of its authorized unit", async t => {
    const f = await recollectionFixture(t);
    const rows = (await readFile(f.files[0], "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.id !== "prompt-outside-B");
    await writeFile(f.files[0], rows.map(row => JSON.stringify(row) + "\n").join(""));
    await f.collector.collectNow();
    await remove(f);
    const controller = createRecollectionController(f.context);
    let preview = await controller.preview("panel", { ...scope(f), restorePrompts: true });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    preview = await controller.preview("panel", { ...scope(f), from: f.secondDay, to: f.secondDay });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    let state = await loadBoardState(f.context);
    assert.deepEqual(new Set(ids(state)), new Set(["selected-A", "outside-B"]));
    const deletion = createDeletionController(f.context);
    const selected = await deletion.preview("panel", { scope: "range", from: f.firstDay, to: f.firstDay, timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("panel", { operationId: selected.operationId, confirmed: true });
    state = await loadBoardState(f.context);
    assert.deepEqual(ids(state), ["outside-B"]);
    assert.equal(state.evidence[0].userPrompt.text, null, "Surviving B did not opt in to restoring deleted shared prompt text");
    assert.deepEqual(state.deletion.promptAuthorizations, {});
    await f.restart(); await f.collector.collectNow();
    assert.equal((await loadBoardState(f.context)).evidence[0].userPrompt.text, null);
});

test("recollection preserves deleted response/feedback guards even when optional capture remains enabled", async t => {
    const f = await recollectionFixture(t);
    let state = await loadBoardState(f.context);
    const source = f.collector.assessmentSource(state);
    await executeAssessmentAction(f.context, "panel", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, expectedSourceRevision: state.evidenceRevision,
        expectedConsentRevision: 0, policyVersion: 1, enabled: true, categories: ["answer"],
        sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    }, { source: value => f.collector.assessmentSource(value) });
    const answer = { id: "deleted-answer", type: "assistant.message", timestamp: `${f.secondDay}T12:00:02.000Z`,
        data: { content: "SYNTHETIC_OPTIONAL_ANSWER_NOT_TO_RESTORE" } };
    await appendFile(f.files[0], JSON.stringify(answer) + "\n");
    await f.collector.collectNow();
    state = await loadBoardState(f.context);
    assert.equal(state.personalEvaluation.captures.length, 1);
    const model = buildAssessmentModel(state);
    await executeAssessmentAction(f.context, "panel", "set_personal_assessment", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: model.overview.interactionRefs[0],
        expectedBasis: model.basis, checkId: "semantic-answer-correctness", verdict: "pass", withdraw: false,
    });
    await remove(f);
    const deleted = await loadBoardState(f.context);
    assert.equal(deleted.personalEvaluation.captures.length, 0);
    assert.equal(deleted.personalEvaluation.feedback.records.length, 0);
    const controller = createRecollectionController(f.context);
    const preview = await controller.preview("panel", { ...scope(f), to: f.secondDay, restorePrompts: true });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    await f.restart(); await f.collector.collectNow();
    state = await loadBoardState(f.context);
    assert.deepEqual(state.personalEvaluation, deleted.personalEvaluation);
    assert.doesNotMatch(JSON.stringify(state.evidence), /SYNTHETIC_OPTIONAL_ANSWER_NOT_TO_RESTORE/);
    assert.equal(state.evidence.length, 2);
});

test("actual Graph records deduplicate and ordinary newly appended calls stay distinct from authorized old records", async t => {
    const f = await recollectionFixture(t);
    const event = (id, type, data) => ({ id, type, timestamp: `${f.firstDay}T13:00:00.000Z`, data });
    await appendFile(f.files[0], [
        event("graph-prompt", "user.message", { content: "Synthetic Graph request" }),
        event("graph-start", "tool.execution_start", { toolName: "powershell", toolCallId: "graph-call",
            arguments: { command: "curl -i https://graph.microsoft.com/v1.0/me/messages" } }),
        event("graph-end", "tool.execution_complete", { toolCallId: "graph-call", success: true, result: { content: "HTTP/2 200\nUNRETAINED_BODY" } }),
    ].map(row => JSON.stringify(row) + "\n").join(""));
    await f.collector.collectNow();
    await remove(f);
    const controller = createRecollectionController(f.context);
    let preview = await controller.preview("panel", scope(f));
    assert.equal(preview.counts.graphRecords, 1);
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    let state = await loadBoardState(f.context);
    assert.equal(buildActivityAnalytics(state.evidence, { layer: "direct-request" }).totals.count, 1);
    assert.equal(buildActivityAnalytics(state.evidence, { layer: "recorded-http" }).totals.count, 1);
    assert.doesNotMatch(JSON.stringify(state.evidence), /UNRETAINED_BODY/);
    preview = await controller.preview("panel", scope(f));
    assert.equal(preview.counts.records, 0);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /No available/);
    await appendFile(f.files[0], JSON.stringify(event("fresh-start", "tool.execution_start", {
        toolCallId: "fresh-call", toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", arguments: { entityUrls: ["/me/messages"] },
    })) + "\n");
    await f.collector.collectNow(); await f.restart(); await f.collector.collectNow();
    state = await loadBoardState(f.context);
    assert.deepEqual(new Set(ids(state)), new Set(["selected-A", "fresh-call"]));
    assert.equal(state.evidence.flatMap(row => row.toolCalls).find(call => call.toolCallId === "fresh-call").recollection, undefined);
});

test("approval bounds, eligibility and no-match never become an all-history authorization", async t => {
    const f = await recollectionFixture(t);
    await remove(f);
    const controller = createRecollectionController(f.context);
    await assert.rejects(controller.preview("panel", { ...scope(f), from: "2001-01-01", to: "2001-01-02" }), /already-approved/);
    await assert.rejects(controller.preview("panel", { ...scope(f), sourceSessionIds: [] }), /Select between/);
    await assert.rejects(controller.preview("panel", { ...scope(f), sourceSessionIds: ["00000000-0000-0000-0000-000000000000"] }), /no longer eligible/);
    await assert.rejects(controller.preview("panel", { ...scope(f), windowDays: 90 }), /Invalid/);
    await assert.rejects(controller.preview("panel", { ...scope(f), restorePrompts: "true" }), /Choose whether/);
    const preview = await controller.preview("panel", { ...scope(f), from: "2001-01-01" });
    assert.ok(preview.scope.since >= preview.scope.window.since);
    assert.equal(preview.counts.records, 1);
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("pending sealed deletion is never bypassed by recollection", async t => {
    const f = await recollectionFixture(t);
    const deletion = createDeletionController(f.context, { afterSeal() { throw new Error("synthetic sealed interruption"); } });
    const preview = await deletion.preview("panel", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await assert.rejects(deletion.confirm("panel", { operationId: preview.operationId, confirmed: true }), /sealed interruption/);
    await assert.rejects(createRecollectionController(f.context).preview("panel", scope(f)), /sealed deletion cleanup/);
    await f.restart();
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

for (const uncertainPrefix of [false, true]) test(`source recollection preserves the kickoff guard across chunks (${uncertainPrefix ? "uncertain" : "complete"} prefix)`, async t => {
    const f = await recollectionFixture(t);
    await remove(f);
    const db = new DatabaseSync(f.dbPath);
    try {
        db.exec("ALTER TABLE workspaces ADD COLUMN created_by TEXT; ALTER TABLE workspaces ADD COLUMN creator_session_id TEXT;");
        db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?)")
            .run(randomUUID(), f.sourceId, null, "Synthetic agent-created child", null, "local", "folder", "agent", f.otherSourceId);
    } finally { db.close(); }
    for (const file of f.files) {
        const events = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
        for (const event of events) if (event.type === "user.message") Object.assign(event.data, {
            messageId: randomUUID(), delivery: "idle", agentMode: "autopilot",
            transformedContent: `<current_datetime>${event.timestamp}</current_datetime>\n\n${event.data.content}`,
        });
        if (file === f.files[0]) {
            const nextPrompt = events.findIndex(event => event.id === "prompt-outside-B");
            events.splice(nextPrompt, 0, ...Array.from({ length: 7 }, (_, index) => ({
                id: `ignored-padding-${index}`, type: "session.info", timestamp: events[0].timestamp,
                data: { content: "SYNTHETIC_PADDING_NOT_RETAINED" + "x".repeat(700000) },
            })));
        }
        const lines = events.map(event => JSON.stringify(event));
        if (file === f.files[0] && uncertainPrefix) lines.splice(1, 0, "synthetic malformed history line");
        await writeFile(file, lines.join("\n") + "\n");
    }
    const sourceBefore = await hashes([f.dbPath, ...f.files]);
    const controller = createRecollectionController(f.context);
    const preview = await controller.preview("panel", { ...scope(f), sourceSessionIds: [f.sourceId, f.otherSourceId],
        to: f.secondDay, restorePrompts: true });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const state = await loadBoardState(f.context);
    const prompts = new Map(state.evidence.map(record => [record.toolCalls[0].toolCallId, record.userPrompt]));
    assert.deepEqual(prompts.get("selected-A").authorship, { actor: "unknown", basis: "missing-source" },
        "Timestamp-only envelope cannot prove a human author for an agent-created kickoff");
    assert.deepEqual(prompts.get("outside-B").authorship, uncertainPrefix ? { actor: "unknown", basis: "missing-source" }
        : { actor: "user", basis: "host-direct-input" },
        "A known first message survives chunk boundaries; an uncertain prefix cannot prove a later human author");
    assert.deepEqual(prompts.get("outside-C").authorship, { actor: "user", basis: "host-direct-input" });
    assert.ok([...prompts.values()].every(prompt => prompt.authorshipVersion === promptAuthorship.version));
    assert.doesNotMatch(JSON.stringify(state.evidence), /transformedContent|<current_datetime>|SYNTHETIC_PADDING_NOT_RETAINED/);
    assert.deepEqual(await hashes([f.dbPath, ...f.files]), sourceBefore);
});
