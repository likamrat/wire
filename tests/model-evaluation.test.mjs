import test from "node:test";
import assert from "node:assert/strict";
import { createEvaluationRequest, validateModelEvaluation, evaluationSummary, MODEL_EVALUATION_RUBRIC, MODEL_EVALUATION_RESPONSE_SCHEMA } from "../lib/model-evaluation.mjs";
import { buildEvaluationPacket } from "../lib/evaluation-evidence.mjs";

function packet() {
    const interactionRef = "interaction-" + "a".repeat(32), sourceConfigRef = "sourceconfig-" + "b".repeat(32);
    const rows = [
        ["user.message", { content: "How many items?", messageId: "message" }],
        ["tool.execution_start", { toolCallId: "call", toolName: "workiq-fetch", arguments: { entityUrls: ["/me/messages"] } }],
        ["tool.execution_complete", { toolCallId: "call", success: true, result: { content: "There are 3 items." } }],
        ["assistant.message", { content: "There are 3 items.", turnId: "t", phase: "final_answer", toolRequests: [] }],
        ["assistant.turn_end", { turnId: "t" }],
    ].map(([type, data], i) => ({ id: `e${i}`, timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(), type, data }));
    return buildEvaluationPacket(rows, {
        interactionRef, sourceSessionId: "source", promptEventId: "e0", promptTimestamp: rows[0].timestamp,
        promptText: rows[0].data.content, toolCallIds: ["call"],
    }, { confirmed: true, sourceConfigRef, sourceConfigRevision: 1, interactionRefs: [interactionRef], categories: ["answer", "references", "usage", "intent"] });
}
const anchor = document => ({ ref: document.ref, start: 0, end: document.text.length });
const grant = value => ({
    confirmed: true, provider: "github-copilot", model: "approved-model", maxCalls: 6, maxAiCredits: 2,
    interactionRefs: [value.interactionRef], sourceConfigRef: value.sourceConfigRef, sourceConfigRevision: value.sourceConfigRevision,
});
function response(value, hash) {
    return {
        schemaVersion: 1, rubricId: MODEL_EVALUATION_RUBRIC.id, rubricVersion: MODEL_EVALUATION_RUBRIC.version,
        packetHash: hash,
        requirements: [{ id: "requirement-1", promptEvidence: [anchor(value.prompt)], answerEvidence: [anchor(value.answer)],
            referenceEvidence: [anchor(value.references[0])], verdict: "met", reason: "supported" }],
        answerSegments: [{ start: 0, end: value.answer.text.length, kind: "factual", verdict: "met",
            referenceEvidence: [anchor(value.references[0])], reason: "supported" }],
        actions: [{ actionRef: value.actions[0].ref, promptEvidence: [anchor(value.prompt)], verdict: "met", reason: "requested" }],
    };
}

test("capture approval alone never authorizes provider submission; request is exact-packet, tool-free and budget-bound", () => {
    const value = packet();
    assert.throws(() => createEvaluationRequest(value, null), /evaluator-not-approved/);
    assert.throws(() => createEvaluationRequest(value, { ...grant(value), maxAiCredits: 0 }), /invalid-evaluation-budget/);
    assert.throws(() => createEvaluationRequest(value, { ...grant(value), interactionRefs: [] }), /interaction-outside-evaluator-grant/);
    const request = createEvaluationRequest(value, grant(value));
    assert.equal(request.destination, "github-copilot");
    assert.deepEqual(request.availableTools, []);
    assert.equal(request.maxModelCalls, 1);
    assert.equal(request.maxAiCredits, 2);
    assert.match(request.system, /untrusted evidence/);
    assert.match(request.system, /not proof of authorization/);
    assert.equal(request.packetHash.length, 64);
});

test("model-assessed summaries compute exact counts, never borrow execution success or return self-confidence", () => {
    const value = packet(), request = createEvaluationRequest(value, grant(value));
    const result = validateModelEvaluation(response(value, request.packetHash), value, request.packetHash);
    const summary = evaluationSummary(result);
    assert.deepEqual(summary.map(metric => [metric.dimension, metric.value, metric.numerator, metric.denominator]), [
        ["accuracy", 1, 1, 1], ["answer-trust", 1, 1, 1], ["action-trust", 1, 1, 1],
    ]);
    assert.ok(summary.every(metric => metric.origin === "model-assessed"));
    assert.equal(summary[2].checkId, "action-intent-alignment");
    assert.doesNotMatch(JSON.stringify(summary), /How many|There are|confidence|authorized/);
});

test("missing reference support cannot become positive accuracy or groundedness, and no action may disappear", () => {
    const value = packet(), request = createEvaluationRequest(value, grant(value));
    const result = response(value, request.packetHash);
    result.requirements[0].referenceEvidence = [];
    assert.throws(() => validateModelEvaluation(result, value, request.packetHash), /positive-accuracy-without-evidence/);
    result.requirements[0].verdict = "insufficient"; result.requirements[0].reason = "missing-evidence";
    result.answerSegments[0].referenceEvidence = [];
    assert.throws(() => validateModelEvaluation(result, value, request.packetHash), /positive-support-without-reference/);
    result.answerSegments[0].verdict = "insufficient"; result.answerSegments[0].reason = "missing-evidence";
    result.actions = [];
    assert.throws(() => validateModelEvaluation(result, value, request.packetHash), /incomplete-action-coverage/);
});

test("stale packet, fabricated anchors, quote mismatches and unreviewed answer spans fail closed", () => {
    const value = packet(), request = createEvaluationRequest(value, grant(value));
    const badHash = response(value, "c".repeat(64));
    assert.throws(() => validateModelEvaluation(badHash, value, request.packetHash), /evaluation-packet-mismatch/);
    const badAnchor = response(value, request.packetHash);
    badAnchor.requirements[0].promptEvidence[0].ref = value.answer.ref;
    assert.throws(() => validateModelEvaluation(badAnchor, value, request.packetHash), /evidence-anchor-kind/);
    const uncovered = response(value, request.packetHash);
    uncovered.answerSegments[0].start = 1;
    assert.throws(() => validateModelEvaluation(uncovered, value, request.packetHash), /incomplete-answer-coverage/);
    const invented = response(value, request.packetHash);
    invented.answerSegments[0].referenceEvidence[0].end += 1;
    assert.throws(() => validateModelEvaluation(invented, value, request.packetHash), /invalid-evidence-anchor/);
});

test("mixed insufficient evidence preserves numeric denominator and all-incomplete stays null", () => {
    const value = packet(), request = createEvaluationRequest(value, grant(value));
    const result = response(value, request.packetHash);
    result.requirements.push({ id: "requirement-2", promptEvidence: [anchor(value.prompt)], answerEvidence: [],
        referenceEvidence: [], verdict: "insufficient", reason: "missing-evidence" });
    result.actions[0].verdict = "not-met"; result.actions[0].reason = "outside-request";
    const summary = evaluationSummary(validateModelEvaluation(result, value, request.packetHash));
    assert.equal(summary[0].value, 1);
    assert.deepEqual(summary[0].coverage, { covered: 1, eligible: 2 });
    assert.equal(summary[2].value, 0);
    for (const requirement of result.requirements) { requirement.verdict = "insufficient"; requirement.reason = "missing-evidence"; }
    assert.equal(evaluationSummary(validateModelEvaluation(result, value, request.packetHash))[0].value, null);
});

test("unknown scoring fields, injected evaluator instructions and confident prose do not bypass the schema", () => {
    const value = packet(), request = createEvaluationRequest(value, grant(value));
    const result = response(value, request.packetHash);
    result.confidence = 0.99;
    assert.throws(() => validateModelEvaluation(result, value, request.packetHash), /unexpected-evaluation-field/);
    assert.throws(() => validateModelEvaluation("Everything looks correct.", value, request.packetHash), /invalid-model-evaluation/);
});

test("validated results cannot be changed after validation and packet projections reject unreviewed fields", () => {
    const value = packet(), request = createEvaluationRequest(value, grant(value));
    const accepted = validateModelEvaluation(response(value, request.packetHash), value, request.packetHash);
    assert.throws(() => { accepted.requirements[0].verdict = "not-met"; }, TypeError);
    assert.throws(() => evaluationSummary(structuredClone(accepted)), /unvalidated-evaluation-result/);
    value.answer.reasoningText = "must not be sent";
    assert.throws(() => createEvaluationRequest(value, grant(value)), /unexpected-evidence-field/);
});

test("packet-specific generation changes only allowed refs, preserves all other schema rules and freezes per-request roles", () => {
    const value = packet(), template = structuredClone(MODEL_EVALUATION_RESPONSE_SCHEMA);
    value.references = Array.from({ length: 100 }, (_, index) => ({
        ...value.references[0], ref: `reference-${(index + 1).toString(16).padStart(32, "0")}`,
    }));
    const request = createEvaluationRequest(value, grant(value)), schema = request.responseSchema;
    assert.deepEqual(schema.$defs.referenceAnchors.items.properties.ref.enum, value.references.map(document => document.ref));
    assert.equal(schema.$defs.referenceAnchors.maxItems, 20, "The existing per-check anchor limit is not widened.");
    const restored = structuredClone(schema);
    for (const name of ["promptAnchors", "answerAnchors", "referenceAnchors"]) delete restored.$defs[name];
    restored.$defs.anchors = structuredClone(template.$defs.anchors);
    const requirement = restored.properties.requirements.items.properties;
    for (const name of ["promptEvidence", "answerEvidence", "referenceEvidence"]) requirement[name].$ref = "#/$defs/anchors";
    restored.properties.answerSegments.items.properties.referenceEvidence.$ref = "#/$defs/anchors";
    restored.properties.actions.items.properties.promptEvidence.$ref = "#/$defs/anchors";
    delete restored.properties.actions.items.properties.actionRef.enum;
    assert.deepEqual(restored, template);
    const firstPrompt = value.prompt.ref;
    value.prompt.ref = "prompt-" + "e".repeat(32);
    const later = createEvaluationRequest(value, grant(value));
    assert.deepEqual(schema.$defs.promptAnchors.items.properties.ref.enum, [firstPrompt]);
    assert.deepEqual(later.responseSchema.$defs.promptAnchors.items.properties.ref.enum, [value.prompt.ref]);
    assert.equal(request.input.packet.prompt.ref, firstPrompt);
    assert.throws(() => schema.$defs.promptAnchors.items.properties.ref.enum.push(value.prompt.ref), TypeError);
    assert.throws(() => { request.responseSchema = template; }, TypeError);
    assert.deepEqual(MODEL_EVALUATION_RESPONSE_SCHEMA, template, "Preparing another packet cannot mutate the shared template.");
});

test("an empty action/reference inventory uses zero-length lists, never empty enums or an invented anchor", () => {
    const value = packet();
    value.actions = []; value.references = [];
    const schema = createEvaluationRequest(value, grant(value)).responseSchema;
    assert.equal(schema.properties.actions.maxItems, 0);
    assert.equal(schema.properties.actions.items.properties.actionRef.enum, undefined);
    assert.equal(schema.$defs.referenceAnchors.maxItems, 0);
    assert.equal(schema.$defs.referenceAnchors.items.properties.ref.enum, undefined);
    assert.equal(schema.$defs.promptAnchors.maxItems, 20);
    assert.deepEqual(schema.$defs.promptAnchors.items.properties.ref.enum, [value.prompt.ref]);
    assert.deepEqual(schema.$defs.answerAnchors.items.properties.ref.enum, [value.answer.ref]);
});
