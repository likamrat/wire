import test from "node:test";
import assert from "node:assert/strict";
import { fixture, privateFixture } from "./helpers.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { buildSanitizedRecord } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

test("the real snapshot carries the original model without adding evaluator, export or private-anchor fields", async t => {
    const record = fixture("model-snapshot"), prompt = { id: "prompt", type: "user.message",
        timestamp: "2026-10-01T12:00:00.000Z", data: { messageId: "logical-prompt" } };
    record.userPrompt = { ...record.userPrompt, sourceEventId: prompt.id, sourceTimestamp: prompt.timestamp };
    const response = { id: "response", type: "assistant.message", timestamp: "2026-10-01T12:00:01.000Z", data: {
        originatingMessageId: "logical-prompt", apiCallId: "private-api-anchor", model: "original-model",
        content: "Not part of the model fact", turnId: "root-turn", phase: "final_answer", toolRequests: [],
    } };
    const events = [prompt, response,
        { id: "end", type: "assistant.turn_end", timestamp: "2026-10-01T12:00:01.100Z", data: { turnId: "root-turn" } }];
    record.responseTiming = recordedResponseTiming(events, record.userPrompt);
    const baseline = structuredClone(record), key = "a".repeat(64);
    record.originalModelEvidence = recordedInteractionModels(events, record);
    const { context } = await privateFixture(t, [record]);
    const before = await loadBoardState(context);
    const payload = await currentStatePayload(context, before);
    assert.deepEqual(payload.scenarios[0].originalModel, { label: "Model", value: "original-model", status: "recorded", models: ["original-model"],
        presentation: { identity: "original-model", completeness: [] } });
    assert.equal(payload.revision, before.revision);
    assert.equal(payload.scenarios[0].scenarioId, record.scenarioId);
    const timing = payload.assessment.catalog.find(row => row.scenarioId === record.scenarioId);
    assert.equal(timing.responseTiming.durationMs, 1000);
    assert.equal(timing.responseTiming.sourceRevision, payload.assessment.basis.sourceRevision);
    assert.equal(timing.responseTiming.interactionRef, timing.interactionRef);
    assert.equal(payload.assessment.capabilities.usage, false);
    assert.doesNotMatch(JSON.stringify(payload), /originalModelEvidence|private-api-anchor|logical-prompt/);
    assert.deepEqual(buildSanitizedRecord(record, key), buildSanitizedRecord(baseline, key));
    assert.equal(evaluationRecordFingerprint(record), evaluationRecordFingerprint(baseline));
    assert.equal((await loadBoardState(context)).revision, before.revision);
});
