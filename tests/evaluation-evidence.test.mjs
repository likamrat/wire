import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRecordedBoundaries, buildEvaluationPacket } from "../lib/evaluation-evidence.mjs";

const at = ms => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + ms).toISOString();
function events() {
    const values = [
        ["session.start", { sessionId: "source", version: 1 }],
        ["session.usage_checkpoint", { totalNanoAiu: 1000000000 }],
        ["user.message", { content: "Return the recorded number of items.", messageId: "message", source: "user" }],
        ["assistant.turn_start", { turnId: "turn-1" }],
        ["tool.execution_start", { toolCallId: "call", toolName: "workiq-fetch", arguments: { entityUrls: ["/me/messages"] } }],
        ["tool.execution_complete", { toolCallId: "call", success: true, result: { content: '{"count":3}', structuredContent: { count: 3 } } }],
        ["assistant.message", { messageId: "answer", originatingMessageId: "message", turnId: "turn-1", phase: "final_answer", content: "There are three items.", model: "example-model", toolRequests: [] }],
        ["assistant.turn_end", { turnId: "turn-1" }],
        ["session.usage_checkpoint", { totalNanoAiu: 1250000000 }],
    ];
    return values.map(([type, data], index) => ({ id: `event-${index}`, parentId: index ? `event-${index - 1}` : null, timestamp: at(index * 100), type, data }));
}
const interaction = () => ({
    interactionRef: "interaction-" + "a".repeat(32), sourceSessionId: "source",
    promptEventId: "event-2", promptTimestamp: at(200), promptText: "Return the recorded number of items.",
    toolCallIds: ["call"],
});
const scope = () => ({
    sourceConfigRef: "sourceconfig-" + "b".repeat(32), sourceConfigRevision: 1,
    interactionRefs: [interaction().interactionRef], categories: ["answer", "references", "usage", "intent"],
    confirmed: true,
});
function insert(values, index, type, data = {}) {
    values.splice(index, 0, { id: `inserted-${index}`, timestamp: at(index * 100 - 1), type, data });
    values.forEach((event, i) => { event.parentId = i ? values[i - 1].id : null; });
}

test("complete exclusive billed interval gives attributable credits and final-answer latency without reading semantic content", () => {
    const source = events(), before = JSON.stringify(source);
    const result = evaluateRecordedBoundaries(source, interaction(), { sourceComplete: true });
    assert.equal(result.latency.status, "measured");
    assert.equal(result.latency.valueMs, 400);
    assert.equal(result.cost.status, "measured");
    assert.equal(result.cost.nanoAiu, 250000000);
    assert.equal(result.cost.aiCredits, 0.25);
    assert.equal(result.cost.attribution, "exclusive-checkpoint-interval");
    assert.deepEqual(result.cost.checkpointEventIds, ["event-1", "event-8"]);
    assert.equal(JSON.stringify(source), before);
    assert.doesNotMatch(JSON.stringify(result), /There are three|Return the recorded/);
});

test("a single observed user message is insufficient when other work crosses the billed boundary", () => {
    const source = events();
    insert(source, 1, "assistant.turn_start", { turnId: "earlier-turn" });
    const result = evaluateRecordedBoundaries(source, interaction(), { sourceComplete: true });
    assert.equal(result.cost.status, "unavailable");
    assert.equal(result.cost.reason, "prior-work-crosses-boundary");
});

test("usage never divides multi-message intervals, invents baseline zero, accepts resets or ignores subagents", () => {
    const cases = [
        ["multiple-interactions-in-billing-interval", source => insert(source, 3, "user.message", { content: "Other request", messageId: "other" })],
        ["missing-billing-boundary", source => source.splice(1, 1)],
        ["billing-counter-reset", source => { source.at(-1).data.totalNanoAiu = 1; }],
        ["unattributed-billable-work", source => insert(source, 5, "subagent.started", { agentId: "child" })],
        ["unattributed-billable-work", source => insert(source, 5, "session.compaction_start", {})],
        ["unfinished-billable-work", source => source.splice(7, 1)],
    ];
    for (const [reason, mutate] of cases) {
        const source = events(); mutate(source);
        source.forEach((event, i) => { event.parentId = i ? source[i - 1].id : null; });
        const result = evaluateRecordedBoundaries(source, interaction(), { sourceComplete: true });
        assert.equal(result.cost.status, "unavailable", reason);
        assert.equal(result.cost.reason, reason);
        assert.equal(Object.hasOwn(result.cost, "nanoAiu"), false);
    }
});

test("broken chain, duplicated/conflicting event IDs and incomplete source fail closed", () => {
    assert.equal(evaluateRecordedBoundaries(events(), interaction(), { sourceComplete: false }).cost.reason, "source-window-incomplete");
    const broken = events(); broken[5].parentId = "missing";
    assert.equal(evaluateRecordedBoundaries(broken, interaction(), { sourceComplete: true }).cost.reason, "source-chain-incomplete");
    const duplicate = events(); duplicate.push({ ...duplicate[3], data: { turnId: "other" } });
    assert.throws(() => evaluateRecordedBoundaries(duplicate, interaction(), { sourceComplete: true }), /conflicting-event/);
});

test("commentary, another originating message, interrupted calls and next-message boundaries are not final-answer latency", () => {
    for (const change of [
        source => { source[6].data.phase = "commentary"; },
        source => { source[6].data.originatingMessageId = "other"; },
        source => { source[6].data.toolRequests = [{ toolCallId: "late" }]; },
        source => insert(source, 6, "user.message", { messageId: "other", content: "Follow-up" }),
    ]) {
        const source = events(); change(source);
        assert.equal(evaluateRecordedBoundaries(source, interaction(), { sourceComplete: true }).latency.status, "unavailable");
    }
});

test("packet requires exact scope/category grant before exposing any additional text", () => {
    assert.throws(() => buildEvaluationPacket(events(), interaction(), null), /evaluation-capture-not-approved/);
    assert.throws(() => buildEvaluationPacket(events(), interaction(), { ...scope(), interactionRefs: [] }), /interaction-outside-grant/);
    assert.throws(() => buildEvaluationPacket(events(), interaction(), { ...scope(), categories: ["usage"] }), /evidence-category-not-approved/);
    const packet = buildEvaluationPacket(events(), interaction(), scope());
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.answer.text, "There are three items.");
    assert.equal(packet.references.length, 1);
    assert.equal(packet.references[0].text, '{"count":3}');
    assert.equal(packet.actions[0].tool, "workiq-fetch");
    assert.equal(packet.origin, "recorded-source");
    assert.equal(packet.authority.kind, "capture-only");
    assert.doesNotMatch(JSON.stringify(packet), /"reasoning\w*":|"encryptedContent":|"sourceSessionId":/);
});

test("credential-bearing, oversized or missing evidence is unavailable, never a partial success-shaped packet", () => {
    const credentials = events(); credentials[5].data.result.content = "password='fixture-private-password'";
    assert.throws(() => buildEvaluationPacket(credentials, interaction(), scope()), /credential-excluded/);
    const huge = events(); huge[6].data.content = "x".repeat(65537);
    assert.throws(() => buildEvaluationPacket(huge, interaction(), scope()), /evidence-limit/);
    const missing = events(); missing.splice(5, 1);
    assert.throws(() => buildEvaluationPacket(missing, interaction(), scope()), /incomplete-tool-evidence/);
});
