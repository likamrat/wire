import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { MODEL_EVALUATION_RESPONSE_SCHEMA as schema, MODEL_EVALUATION_RUBRIC } from "../lib/model-evaluation.mjs";
import { evaluationFixture, assessed, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { CopilotClient, RuntimeConnection, observed, setSyntheticResponder, finiteSchemaTypeIssue } from "./fixtures/copilot-sdk-nonstarting.mjs";

const leaves = [
    [["properties", "schemaVersion"], "integer"],
    [["properties", "rubricId"], "string"],
    [["properties", "rubricVersion"], "integer"],
    [["properties", "answerSegments", "items", "properties", "kind"], "string"],
    [["$defs", "verdict"], "string"], [["$defs", "reason"], "string"],
];
const nodeAt = (value, path) => path.reduce((node, part) => node[part], value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fakeExecutable = fileURLToPath(import.meta.url);
function originalSchema() {
    const original = structuredClone(schema);
    for (const [path] of leaves) delete nodeAt(original, path).type;
    assert.equal(hash(original), "999ff72ac01ed8463be4b836bcd0424c9927dc3eaa7c65f7915e810bc9dc7052",
        "Only the six explicit types may differ from the consumed request's schema.");
    return original;
}
async function rejectedSchema(value) {
    setSyntheticResponder(() => assert.fail("A rejected schema cannot reach the synthetic answer provider."));
    const events = [], client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: fakeExecutable }) });
    const session = await client.createSession({ sessionLimits: { maxAiCredits: 30 }, onEvent: event => events.push(event) });
    const rpcBefore = observed.rpc.length;
    try {
        await assert.rejects(session.sendAndWait({ prompt: "Invented schema contract test.", responseSchema: value }, 120000), /schema must have a 'type' key/);
        assert.equal(observed.rpc.length, rpcBefore + 1);
        assert.equal(observed.rpc.at(-1).state, "resolved");
        assert.equal(observed.rpc.at(-1).messageIdReturned, true);
        assert.equal(events[0].type, "session.error");
        assert.equal(events[0].data.errorType, "query");
        assert.equal(events[0].data.statusCode, 400);
        assert.equal(observed.processesStarted, 0);
        return observed.schemaRejections.at(-1);
    } finally { await session.disconnect(); await client.stop(); }
}

test("default installed evaluator passes the finite-type provider boundary and persists all three controlled metrics", async t => {
    const f = await evaluationFixture(t);
    await materializeEvaluationSource(f);
    const keys = ["WORKIQ_EVIDENCE_COPILOT_SDK", "WORKIQ_EVIDENCE_COPILOT_CLI"];
    const previous = keys.map(key => process.env[key]);
    process.env.WORKIQ_EVIDENCE_COPILOT_SDK = fileURLToPath(new URL("./fixtures/copilot-sdk-nonstarting.mjs", import.meta.url));
    process.env.WORKIQ_EVIDENCE_COPILOT_CLI = fakeExecutable;
    t.after(() => keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }));
    const sendsBefore = observed.sends, rejectionsBefore = observed.schemaRejections.length;
    setSyntheticResponder(({ message, options, emit }) => {
        const input = JSON.parse(message.prompt);
        const result = assessed({ input, packetHash: input.packetHash, model: options.model,
            rubricId: MODEL_EVALUATION_RUBRIC.id, rubricVersion: MODEL_EVALUATION_RUBRIC.version }, false);
        emit({ type: "assistant.usage", data: { apiCallId: "typed-schema-fixture", model: options.model,
            copilotUsage: { totalNanoAiu: 100000000 } } });
        return { type: "assistant.message", data: { content: JSON.stringify(result.rawResult) } };
    });
    const controller = createEvaluationController(f.context, { getSourceConfig: () => f.config });
    t.after(() => controller.close());
    await controller.start("typed-schema-fixture", { ...f.input, maxAiCredits: 30, scenarioIds: [f.input.scenarioIds[0]] });
    await controller.settle();
    const receipt = await controller.status("typed-schema-fixture", { runRef: f.input.mutationRef });
    assert.equal(receipt.phase, "complete");
    assert.equal(receipt.callsReserved, 1); assert.equal(receipt.spentAiCredits, 0.1); assert.equal(receipt.costUnknown, false);
    assert.equal(observed.sends, sendsBefore + 1); assert.equal(observed.schemaRejections.length, rejectionsBefore);
    assert.equal(f.calls.length, 0, "The injected evaluator factory must not be used.");
    const state = await loadBoardState(f.context);
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 1);
    const metrics = buildAssessmentModel(state).overview.metrics.filter(metric => metric.origin === "model-assessed");
    assert.deepEqual(metrics.map(metric => [metric.dimension, metric.value]), [["accuracy", 1], ["answer-trust", 1], ["action-trust", 1]]);
    assert.equal(observed.processesStarted, 0);
    assert.deepEqual(observed.rpc.at(-1).params.responseFormat, {
        type: "json_schema", jsonSchema: { name: "response", strict: true, schema },
    });
});

test("all six finite leaves have the correct primitive type and every other schema rule remains byte-equivalent", () => {
    originalSchema();
    for (const [path, type] of leaves) assert.equal(nodeAt(schema, path).type, type, path.join("."));
    assert.equal(finiteSchemaTypeIssue(schema), null);
});

test("the exact original schema reproduces acknowledged send then query400 at properties.schemaVersion", async () => {
    assert.deepEqual(await rejectedSchema(originalSchema()), { path: ["properties", "schemaVersion"], reason: "missing-type" });
});

test("each of the six finite leaf omissions independently fails the same strict provider boundary", async () => {
    for (const [path] of leaves) {
        const changed = structuredClone(schema); delete nodeAt(changed, path).type;
        assert.deepEqual(await rejectedSchema(changed), { path, reason: "missing-type" });
    }
});

test("the finite rule checks value/type consistency but does not mistake maps or ref-only nodes for missing types", () => {
    assert.equal(finiteSchemaTypeIssue({
        type: "object", properties: { const: { $ref: "#/$defs/item" }, enum: { $ref: "#/$defs/item" } },
        $defs: { item: { type: "string", enum: ["x"] } },
    }), null);
    assert.deepEqual(finiteSchemaTypeIssue({ type: "string", const: 1 }), { path: [], reason: "finite-value-type-mismatch" });
    assert.deepEqual(finiteSchemaTypeIssue({ type: "integer", enum: [1, "2"] }), { path: [], reason: "finite-value-type-mismatch" });
});
