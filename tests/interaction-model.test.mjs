import test from "node:test";
import assert from "node:assert/strict";
import { recordedInteractionModels, interactionModelFact, retainInteractionModelMetadata, projectInteractionModels, restoreRetainedInteractionModelMetadata } from "../lib/interaction-model.mjs";
import { retainResponseTimingEvent } from "../lib/response-timing.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";

const at = ms => new Date(Date.UTC(2026, 9, 1, 12) + ms).toISOString();
const record = {
    sourceSessionId: "source-one", userPrompt: { sourceEventId: "prompt", sourceTimestamp: at(0) },
};
const prompt = { id: "prompt", type: "user.message", timestamp: at(0), data: { messageId: "message-one" } };
function answer(id, model, ms = 100) {
    return { id, type: "assistant.message", timestamp: at(ms), data: {
        originatingMessageId: "message-one", apiCallId: `api-${id}`, model,
        phase: "final_answer", turnId: `turn-${id}`, content: "Response text must not become model metadata.", toolRequests: [],
    } };
}
const end = response => ({ id: `end-${response.id}`, type: "assistant.turn_end",
    timestamp: at(Date.parse(response.timestamp) - Date.parse(at(0)) + 1), data: { turnId: response.data.turnId } });

test("an explicitly linked original response supplies the interaction model without response text", () => {
    const response = answer("answer", "recorded-model-a");
    const evidence = recordedInteractionModels([prompt, response, end(response)], record);
    assert.deepEqual(interactionModelFact({ ...record, originalModelEvidence: evidence }), {
        label: "Model", value: "recorded-model-a", status: "recorded",
    });

    assert.doesNotMatch(JSON.stringify(evidence), /Response text|content|final_answer/);
});

test("recorded response order preserves switches back while collapsing adjacent identical models", () => {
    const responses = [answer("a", "model-a", 100), answer("b", "model-a", 200),
        answer("c", "model-b", 300), answer("d", "model-a", 400)];
    const evidence = recordedInteractionModels([prompt, ...responses, end(responses.at(-1))], record);
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: evidence }).value, "model-a then model-b then model-a");
});

test("missing response metadata and unfinished collections remain qualified", () => {
    const first = answer("a", "model-a"), last = answer("b", undefined, 200);
    const evidence = recordedInteractionModels([prompt, first, last, end(last)], record);
    assert.deepEqual(interactionModelFact({ ...record, originalModelEvidence: evidence }), {
        label: "Model", value: "model-a (some response models missing)", status: "partial",
    });
    const pending = recordedInteractionModels([prompt, first], record);
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: pending }).value, "model-a (partial record)");
    const complete = recordedInteractionModels([prompt, first, end(first)], record);
    const lost = recordedInteractionModels([], { ...record, originalModelEvidence: complete }, { partialWindow: true });
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: lost }).value, "model-a (partial record)");
});

test("retention allowlists only model anchors and excludes credentials or malformed labels without reading text", () => {
    const response = answer("a", "deployment/Exact Model");
    Object.defineProperty(response.data, "content", { get() { throw new Error("No response text access"); } });
    Object.defineProperty(response.data, "reasoningText", { get() { throw new Error("No reasoning access"); } });
    assert.deepEqual(retainInteractionModelMetadata(response), {
        version: 1, model: "deployment/Exact Model", modelStatus: "recorded",
        originatingMessageId: "message-one", apiCallId: "api-a",
    });
    for (const model of ["Bearer " + "a".repeat(30), "api_key=example-secret", ["model-a"], "x".repeat(513), "bad\nlabel"]) {
        const projected = retainInteractionModelMetadata(answer("unsafe", model));
        assert.equal(projected.model, null);
        assert.equal(projected.modelStatus, "excluded");
        assert.doesNotMatch(JSON.stringify(projected), /Bearer|example-secret|bad\\nlabel/);
    }
});

test("an unlinked root response leaves the recorded models explicitly incomplete", () => {
    const known = answer("known", "model-a", 200), unlinked = answer("unknown", "unattributable-model", 100);
    delete unlinked.data.originatingMessageId;
    const evidence = recordedInteractionModels([prompt, unlinked, known, end(known)], record);
    const fact = interactionModelFact({ ...record, originalModelEvidence: evidence });
    assert.equal(fact.value, "model-a (some response models missing)");
    assert.doesNotMatch(JSON.stringify(evidence), /unattributable-model/);
});

test("only explicit root-response ownership can supply a model, never settings, tool hints or another interaction", () => {
    const root = answer("root", "root-model");
    const child = { ...answer("child", "child-model"), agentId: "child" };
    const neighboring = { ...answer("neighbor", "neighbor-model"), data: { ...root.data, originatingMessageId: "other-message", model: "neighbor-model" } };
    const events = [prompt, child, neighboring, { id: "session", type: "session.start", data: { model: "default-model" } }];
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: recordedInteractionModels(events, record) }).value, "Not recorded");
    const evidence = recordedInteractionModels([prompt, root, end(root)], record);
    assert.equal(interactionModelFact({ ...record, sourceSessionId: "other-source", originalModelEvidence: evidence }).status, "unverified");
    const ambiguous = recordedInteractionModels([prompt, { ...prompt, id: "second-prompt" }, root, end(root)], record);
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: ambiguous }).status, "unverified");
    assert.equal(interactionModelFact({ ...record, toolCalls: [{ model: "tool-hint" }] }).value, "Not verified (tool metadata only)");
    assert.equal(interactionModelFact({ ...record, model: "current-setting", reviewer: { model: "review-model" } }).value, "Not recorded");
});

test("late responses merge across batches without losing changes, and conflicting identities fail closed", () => {
    const first = answer("a", "model-a", 100), last = answer("b", "model-b", 200);
    const initial = recordedInteractionModels([prompt, first, end(first)], record);
    const laterRecord = { ...record, originalModelEvidence: initial };
    const later = recordedInteractionModels([last, end(last)], laterRecord);
    assert.match(interactionModelFact({ ...record, originalModelEvidence: later }).value, /^model-a then model-b/);
    assert.equal(later.responses.length, 2);
    const repeated = recordedInteractionModels([last], { ...record, originalModelEvidence: later });
    assert.equal(repeated.responses.length, 2);
    const conflict = recordedInteractionModels([{ ...last, data: { ...last.data, model: "different" } }], { ...record, originalModelEvidence: later });
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: conflict }).value, "Conflicting records");
    const requestConflict = recordedInteractionModels([prompt, first, { ...last, data: { ...last.data, apiCallId: first.data.apiCallId } }, end(last)], record);
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: requestConflict }).value, "Conflicting records");
});

test("simultaneous or unseparated responses show multiple models without inventing a switch order", () => {
    for (const second of [answer("b", "model-b", 100),
        { ...answer("b", "model-b", 200), data: { ...answer("b", "model-b", 200).data, turnId: "turn-a" } }]) {
        const first = answer("a", "model-a", 100);
        const evidence = recordedInteractionModels([prompt, first, second, end(second)], record);
        assert.equal(interactionModelFact({ ...record, originalModelEvidence: evidence }).value, "model-a, model-b (order not recorded)");
    }
});

test("unsupported retained metadata is explicit and cannot bypass model-label screening", () => {
    const response = answer("a", "model-a");
    const evidence = recordedInteractionModels([prompt, response, end(response)], record);
    for (const changed of [
        { ...evidence, responses: {} },
        { ...evidence, responses: [{ ...evidence.responses[0], model: "api_key=not-for-display" }] },
        { ...evidence, version: 99 },
    ]) {
        const fact = interactionModelFact({ ...record, originalModelEvidence: changed });
        assert.equal(fact.status, "unverified");
        assert.doesNotMatch(fact.value, /not-for-display|model-a/);
    }
});

test("snapshot aliases share the same model fact without exposing new private anchors or mutating evidence", () => {
    const first = answer("a", "model-a", 100), last = answer("b", "model-b", 200);
    const records = [
        { ...record, scenarioId: "alias-a", originalModelEvidence: recordedInteractionModels([prompt, first, end(first)], record) },
        { ...record, scenarioId: "alias-b", originalModelEvidence: recordedInteractionModels([prompt, last, end(last)], record) },
        { ...record, scenarioId: "different-source", sourceSessionId: "source-two" },
    ];
    const before = JSON.stringify(records), projected = projectInteractionModels(records);
    assert.deepEqual(projected[0].originalModel, projected[1].originalModel);
    assert.equal(projected[0].originalModel.value, "model-a then model-b");
    assert.equal(projected[2].originalModel.value, "Not recorded");
    assert.ok(projected.every(value => !Object.hasOwn(value, "originalModelEvidence")));
    assert.doesNotMatch(JSON.stringify(projected), /api-a|api-b|promptMessageId/);
    assert.equal(JSON.stringify(records), before);
});

test("screen identity and completeness share core qualification without changing core fact bytes", () => {
    const a = answer("a", "model-a"), b = answer("b", "model-b", 200), missing = answer("missing", undefined, 200),
        again = answer("again", "model-a", 300), literal = answer("literal", "model (partial record)");
    const complete = recordedInteractionModels([prompt, a, end(a)], record);
    const cases = [
        [complete, "model-a", []],
        [{ ...complete, partial: true }, "model-a", ["unverified-final-boundary"]],
        [{ ...complete, truncated: true }, "model-a", ["truncated-history"]],
        [{ ...complete, truncated: true, responses: Array.from({ length: 256 }, (_, index) => ({
            ...complete.responses[0], eventId: `retained-${index}`, apiCallId: `retained-api-${index}`, at: at(index + 1),
        })) }, "model-a", ["truncated-history"]],
        [{ ...complete, unlinked: true }, "model-a", ["missing-response-models"]],
        [recordedInteractionModels([prompt, a, missing, end(missing)], record),
            "model-a", ["missing-response-models"]],
        [recordedInteractionModels([prompt, a, { ...b, timestamp: a.timestamp }, end(a)], record),
            "model-a, model-b (order not recorded)", ["unverified-final-boundary"]],
        [recordedInteractionModels([prompt, a, b, again, end(again)], record),
            "model-a then model-b then model-a", []],
        [recordedInteractionModels([prompt, literal, end(literal)], record),
            "model (partial record)", []],
    ];
    for (const [evidence, identity, completeness] of cases) {
        const value = { ...record, originalModelEvidence: evidence }, before = JSON.stringify(value);
        const core = JSON.stringify(interactionModelFact(value));
        const { presentation, models, ...projectedCore } = projectInteractionModels([value])[0].originalModel;
        assert.equal(JSON.stringify(projectedCore), core);
        assert.deepEqual(presentation, { identity, completeness });
        assert.deepEqual(Object.keys(presentation), ["identity", "completeness"]);
        assert.doesNotMatch(JSON.stringify(presentation), /api-a|message-one|source-one|promptEventId|responses|256/);
        assert.equal(JSON.stringify(value), before);
    }
    for (const value of [
        { ...record, originalModelEvidence: { ...complete, ambiguous: true } },
        { ...record, originalModelEvidence: { ...complete, conflict: true } },
        { ...record, originalModelEvidence: { ...complete, invalid: true } },
        { ...record, originalModelEvidence: { ...complete, sourceSessionId: "wrong" } },
        { ...record, toolCalls: [{ model: "unverified-tool-model" }] },
        { ...record, originalModelEvidence: { ...complete, responses: [{ ...complete.responses[0], model: null, modelStatus: "excluded" }] } },
        { ...record },
    ]) {
        const { presentation, models, ...projectedCore } = projectInteractionModels([value])[0].originalModel;
        assert.equal(presentation, undefined);
        assert.deepEqual(models, []);
        assert.deepEqual(projectedCore, interactionModelFact(value));
    }
});

test("contradictory ownership and unsupported projection versions never keep a previously verified model", () => {
    const response = answer("a", "model-a");
    const evidence = recordedInteractionModels([prompt, response, end(response)], record);
    const changed = { ...response, data: { ...response.data, originatingMessageId: "different-prompt" } };
    const conflict = recordedInteractionModels([changed], { ...record, originalModelEvidence: evidence });
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: conflict }).status, "conflicting");
    const missingAnchor = { ...evidence, promptMessageId: null };
    assert.equal(interactionModelFact({ ...record, originalModelEvidence: missingAnchor }).status, "unverified");
    const unsupported = { ...response, data: { ...response.data, wireOriginalModel: {
        ...retainInteractionModelMetadata(response), version: 2,
    } } };
    const projected = recordedInteractionModels([prompt, unsupported, end(unsupported)], record);
    assert.doesNotMatch(interactionModelFact({ ...record, originalModelEvidence: projected }).value, /model-a/);
});

test("only exact legacy checkpoint omissions reuse qualified model metadata during ordinary replay", () => {
    const response = answer("a", "model-a"), old = retainResponseTimingEvent(response);
    const evidence = recordedInteractionModels([prompt, response, end(response)], record);
    const qualified = { ...record, originalModelEvidence: evidence };
    const restored = restoreRetainedInteractionModelMetadata([old], [qualified], record.sourceSessionId)[0];
    assert.deepEqual(restored.data.wireOriginalModel, retainInteractionModelMetadata(response));
    assert.equal(old.data.wireOriginalModel, undefined);
    for (const changed of [
        { ...old, agentId: "child" },
        { ...old, timestamp: at(500) },
        { ...old, data: { ...old.data, originatingMessageId: "other" } },
        { ...old, data: { ...old.data, turnId: "other" } },
        { ...old, data: { ...old.data, model: null } },
        { ...old, data: { ...old.data, apiCallId: "other" } },
        { ...old, data: { ...old.data, wireOriginalModel: retainInteractionModelMetadata(answer("a", undefined)) } },
    ]) assert.equal(restoreRetainedInteractionModelMetadata([changed], [qualified], record.sourceSessionId)[0], changed);
    assert.equal(restoreRetainedInteractionModelMetadata([old], [qualified], "different-source")[0], old);
    const conflicting = { ...qualified, originalModelEvidence: { ...evidence,
        responses: [{ ...evidence.responses[0], model: "different" }] } };
    assert.equal(restoreRetainedInteractionModelMetadata([old], [qualified, conflicting], record.sourceSessionId)[0], old);
});

test("manual extractors retain valid calls and qualify models when raw history contains non-event JSON", () => {
    const response = answer("a", "model-a");
    const source = { sessionId: record.sourceSessionId };
    const events = [prompt, null, 42, [], { unrelated: true },
        { id: "work", type: "tool.execution_start", timestamp: at(10), data: {
            toolName: "workiq-fetch", toolCallId: "work-call", arguments: { entityUrls: ["/me/messages"] },
        } },
        { id: "graph", type: "tool.execution_start", timestamp: at(20), data: {
            toolName: "powershell", toolCallId: "graph-call", arguments: { command: "curl https://graph.microsoft.com/v1.0/me/messages" },
        } },
        response, end(response)];
    const work = extractScenarios(events, source, at(0), at(1000)).scenarios[0];
    const graph = extractGraphActivities(events, source, { since: at(0), until: at(1000) }).scenarios[0];
    assert.equal(work.toolCalls[0].toolCallId, "work-call");
    assert.equal(graph.graphActivities[0].toolCallId, "graph-call");
    for (const value of [work, graph]) {
        assert.deepEqual(interactionModelFact(value), { label: "Model", value: "model-a (partial record)", status: "partial" });
        assert.equal(value.originalModelEvidence.responses.length, 1);
    }
});
