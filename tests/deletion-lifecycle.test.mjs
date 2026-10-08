import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture } from "./helpers.mjs";
import { updateBoardState, loadBoardState } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { deletionHash, recordUnits, eventIdentity } from "../lib/deletion-identities.mjs";
import { defaultPersonalEvaluation, selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";
import { finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { exclusiveBoard } from "../lib/store.mjs";
import { randomUUID } from "node:crypto";

const ref = (kind, digit = "1") => `${kind}-${digit.repeat(32)}`;
const at = "2026-10-06T12:00:00.000Z";
const all = { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } };

async function capturedFixture(t, { spanning = false } = {}) {
    const record = fixture("linked");
    record.toolCalls[0].startedAt = "2026-10-04T12:00:00.000Z";
    if (spanning) record.toolCalls.push({ ...record.toolCalls[0], toolCallId: "retained-call", startEventId: "retained-start", startedAt: "2026-10-05T12:00:00.000Z" });
    const { context } = await privateFixture(t, [record]);
    const basis = { sourceRevision: 1, membershipRevision: 1, consentRevision: 1, overrideRevision: 0, deletionEpoch: 0 };
    const deletionKeys = recordUnits(record).flatMap(unit => unit.aliases);
    const dependencies = { interactionRefs: [ref("interaction")], recordRefs: [ref("record")], evidenceRefs: [ref("evidence")], deletionKeys, basis };
    const captureKeys = [{ category: "answer", eventHash: eventIdentity(record.sourceSessionId, "answer-event") }];
    const text = "SYNTHETIC_CAPTURE_TO_PURGE_秘密";
    const envelope = { schemaVersion: 1, category: "answer", observationRef: ref("observation"), interactionRef: ref("interaction"),
        dependencies, consentRevision: 1, credentialScreenVersion: 1, captureKeys, text };
    const bytes = JSON.stringify(envelope), payloadFile = `${deletionHash(bytes)}.json`;
    await mkdir(path.join(context.dataDir, "assessment-evidence"));
    const payload = path.join(context.dataDir, "assessment-evidence", payloadFile);
    await writeFile(payload, bytes);
    const personal = defaultPersonalEvaluation();
    personal.source = { available: true, sourceConfigRef: ref("config"), sourceConfigRevision: 1 };
    personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"], sourceConfigRef: ref("config"),
        sourceConfigRevision: 1, grantedAt: at, grantOrigin: "explicit-in-app-setup" };
    personal.captures.push({ category: "answer", dependencies, payloadFile, captureKeys, observation: {
        schemaVersion: 1, interactionRef: ref("interaction"), basis, createdAt: at, evidenceRefs: [ref("evidence")],
        observationRef: ref("observation"), memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
        availability: "available", reason: null, occurredAt: at, sourceEventRefs: [ref("event")], deletionKeys,
        payload: { textRef: ref("text"), utf8Bytes: Buffer.byteLength(text), completeness: "full-record", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
        captureContext: { consentRevision: 1, sourceConfigRef: ref("config"), sourceConfigRevision: 1 },
    } });
    for (let index = 1; index <= 2; index++) personal.feedback.records.push({ schemaVersion: 1, dependencies, assessment: {
        schemaVersion: 1, interactionRef: ref("interaction"), basis, createdAt: at, evidenceRefs: [ref("evidence")],
        assessmentRef: ref("assessment", String(index)), checkId: "semantic-answer-correctness", checkVersion: 1, dimension: "accuracy",
        unitRef: ref("interaction"), origin: "user-personal", rubricVersion: 1, verdict: "pass", reason: "user-verdict",
        revision: index, supersedes: index === 1 ? null : ref("assessment"), withdrawn: false,
    } });
    personal.feedback.revision = 2;
    personal.overrideRevision = 2;
    personal.mutations[ref("mutation")] = { ownerHash: deletionHash("panel"), inputHash: deletionHash("input"), dependencies,
        receipt: { schemaVersion: 1, mutationRef: ref("mutation"), phase: "complete", basis, data: { assessment: personal.feedback.records.at(-1).assessment } } };
    await updateBoardState(context, state => { state.personalEvaluation = personal; });
    const before = await loadBoardState(context);
    await writeFile(path.join(context.dataDir, "prior-state.snapshot.json"), JSON.stringify(before));
    return { context, record, before, payload, payloadFile, captureKeys, envelope };
}

test("activity deletion really purges linked capture payloads, feedback and recovery copies while retaining consent and replay reservations", async t => {
    const { context, before, payload, captureKeys } = await capturedFixture(t);
    const controller = createDeletionController(context, { selectPersonalEvaluationCleanup });
    const preview = await controller.preview("panel", all);
    assert.equal(preview.counts.records, 1, "Linked insights are not extra source record units");
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    await assert.rejects(access(payload), { code: "ENOENT" });
    const state = await loadBoardState(context);
    assert.deepEqual(state.personalEvaluation.consent, before.personalEvaluation.consent);
    assert.deepEqual(state.personalEvaluation.captures, []);
    assert.deepEqual(state.personalEvaluation.feedback.records, []);
    assert.deepEqual(state.personalEvaluation.suppressedCaptures, captureKeys);
    assert.equal(state.personalEvaluation.mutations[ref("mutation")].receipt.phase, "purged");
    assert.equal(state.personalEvaluation.mutations[ref("mutation")].receipt.data, undefined);
    assert.equal(state.deletion.events.includes(captureKeys[0].eventHash), false, "Capture-only suppression does not erase base fallback prose");
    const recovery = JSON.parse(await readFile(path.join(context.dataDir, "prior-state.snapshot.json")));
    assert.deepEqual(recovery.personalEvaluation.captures, []);
    assert.deepEqual(recovery.personalEvaluation.feedback.records, []);
});

test("source-day range purges later-created shared insights without tombstoning the surviving call", async t => {
    const { context, record, payload, captureKeys } = await capturedFixture(t, { spanning: true });
    const controller = createDeletionController(context, { selectPersonalEvaluationCleanup });
    const preview = await controller.preview("panel", { scope: "range", from: "2026-10-04", to: "2026-10-04", timeContext: all.timeContext });
    assert.equal(preview.counts.records, 1);
    assert.equal(preview.counts.partialGroups, 1);
    assert.equal(preview.linkedInsights.interactions, 1);
    assert.equal(preview.linkedInsights.feedbackRevisions, 2);
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const state = await loadBoardState(context);
    assert.deepEqual(state.evidence[0].toolCalls, [record.toolCalls[1]]);
    assert.equal(state.evidence[0].assessmentMembershipPruned, true);
    const survivingAliases = recordUnits({ ...record, toolCalls: [record.toolCalls[1]] }).flatMap(unit => unit.aliases);
    assert.ok(survivingAliases.every(key => !state.deletion.identities.includes(key)));
    assert.deepEqual(state.personalEvaluation.suppressedCaptures, captureKeys);
    await assert.rejects(access(payload), { code: "ENOENT" });
    const recovery = JSON.parse(await readFile(path.join(context.dataDir, "prior-state.snapshot.json")));
    assert.equal(recovery.deletion.epoch, 1);
    assert.deepEqual(recovery.personalEvaluation.feedback.records, []);
});

test("already-locked capture revocation purges payloads and finalizes receipts without deleting base observations", { timeout: 10000 }, async t => {
    const { context, before, payload, captureKeys } = await capturedFixture(t);
    const operationId = randomUUID(), mutationRef = ref("mutation", "4");
    const controller = createDeletionController(context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup,
        afterSeal: async () => {
            const disk = JSON.parse(await readFile(path.join(context.dataDir, "workiq-evidence-board-v1.state.json")));
            assert.equal(disk.personalEvaluation.mutations[mutationRef].receipt.phase, "pending");
            assert.equal(disk.personalEvaluation.consent.state, "revoked");
        },
    });
    await exclusiveBoard(context, async (state, save) => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, revision: 2, state: "revoked", categories: [], revokedAt: at };
        state.personalEvaluation.mutations[mutationRef] = {
            ownerHash: deletionHash("panel"), inputHash: deletionHash("revoke"), dependencies: null,
            receipt: { schemaVersion: 1, mutationRef, operationId, phase: "pending",
                basis: state.personalEvaluation.captures[0].dependencies.basis, data: { consent: state.personalEvaluation.consent } },
        };
        await controller.commitCaptureRevocation(state, save, { owner: "panel", operationId, revokedConsentRevision: 1 });
    });
    const state = await loadBoardState(context);
    assert.deepEqual(state.evidence, before.evidence);
    assert.equal(state.evidenceFile, before.evidenceFile);
    assert.deepEqual(state.cards, before.cards);
    assert.deepEqual(state.personalEvaluation.captures, []);
    assert.deepEqual(state.personalEvaluation.suppressedCaptures, captureKeys);
    assert.deepEqual(state.deletion.identities, []);
    assert.deepEqual(state.deletion.events, []);
    assert.equal(state.personalEvaluation.mutations[mutationRef].receipt.phase, "complete");
    assert.equal(state.personalEvaluation.mutations[mutationRef].receipt.basis.deletionEpoch, 1);
    await assert.rejects(access(payload), { code: "ENOENT" });
    const recovery = JSON.parse(await readFile(path.join(context.dataDir, "prior-state.snapshot.json")));
    assert.equal(recovery.personalEvaluation.consent.state, "revoked");
    assert.deepEqual(recovery.personalEvaluation.captures, []);
});

test("capture-only revoked cleanup recovers original targets and finalizes the original pending mutation receipt", async t => {
    const { context, before, payload } = await capturedFixture(t);
    const operationId = randomUUID(), mutationRef = ref("mutation", "6");
    const controller = createDeletionController(context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup,
        afterSeal: () => { throw new Error("SYNTHETIC_CAPTURE_CLEANUP_CRASH"); },
    });
    await assert.rejects(exclusiveBoard(context, async (state, save) => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, revision: 2, state: "revoked", categories: [], revokedAt: at };
        state.personalEvaluation.mutations[mutationRef] = {
            ownerHash: deletionHash("panel"), inputHash: deletionHash("revoke"), dependencies: null,
            receipt: { schemaVersion: 1, mutationRef, operationId, phase: "pending", basis: state.personalEvaluation.captures[0].dependencies.basis,
                data: { consent: state.personalEvaluation.consent } },
        };
        await controller.commitCaptureRevocation(state, save, { owner: "panel", operationId, revokedConsentRevision: 1 });
    }), /SYNTHETIC_CAPTURE_CLEANUP_CRASH/);
    assert.equal((await controller.status(operationId)).phase, "pending");
    await assert.rejects(loadBoardState(context), /incomplete/);
    await createDeletionController(context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup }).recover();
    const state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.mutations[mutationRef].receipt.phase, "complete");
    assert.deepEqual(state.evidence, before.evidence);
    await assert.rejects(access(payload), { code: "ENOENT" });
    const recovered = JSON.parse(await readFile(path.join(context.dataDir, "prior-state.snapshot.json")));
    assert.equal(recovered.deletion.epoch, 1);
    assert.equal(recovered.personalEvaluation.consent.state, "revoked");
});

test("valid unindexed capture orphans follow owner-source dates, not the later answer timestamp", async t => {
    const { context, envelope, payload } = await capturedFixture(t);
    const orphan = { ...envelope, observationRef: ref("observation", "7"), text: "SYNTHETIC_FAILED_STATE_COMMIT" };
    const orphanBytes = JSON.stringify(orphan), orphanFile = path.join(context.dataDir, "assessment-evidence", `${deletionHash(orphanBytes)}.json`);
    await writeFile(orphanFile, orphanBytes);
    const controller = createDeletionController(context, { selectPersonalEvaluationCleanup });
    const preview = await controller.preview("panel", { scope: "range", from: "2026-10-04", to: "2026-10-04", timeContext: all.timeContext });
    assert.equal(preview.linkedInsights.capturedItems, 2);
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    await assert.rejects(access(payload), { code: "ENOENT" });
    await assert.rejects(access(orphanFile), { code: "ENOENT" });
});
