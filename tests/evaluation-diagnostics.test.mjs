import test from "node:test";
import assert from "node:assert/strict";
import { evaluationFixture } from "./evaluation-fixture.mjs";
import { buildEvaluationPacket } from "../lib/evaluation-evidence.mjs";
import { createEvaluationDiagnostic, readEvaluationDiagnostic, validateEvaluationDiagnostic } from "../lib/evaluation-diagnostics.mjs";

const secretMarker = "SYNTHETIC_PRIVATE_ERROR_CONTENT";

test("historical diagnostics reject unrecognized fields and cannot be forged by error properties", () => {
    const error = Object.assign(new Error(secretMarker), { code: secretMarker, diagnostic: { stage: "send", message: secretMarker } });
    assert.equal(readEvaluationDiagnostic(error), null);
    const diagnostic = createEvaluationDiagnostic(error, { stage: "source-read", sendInvoked: false });
    assert.equal(diagnostic.errorCode, "unknown-error");
    const missingCli = createEvaluationDiagnostic(new Error("Copilot CLI not found at " + secretMarker), { stage: "session-create", sendInvoked: false });
    assert.equal(missingCli.errorCode, "cli-executable-not-found");
    assert.doesNotMatch(JSON.stringify(missingCli), new RegExp(secretMarker));
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secretMarker));
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, message: secretMarker }), /Invalid safe/);
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, stage: secretMarker }), /Invalid safe/);
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, sendInvoked: false, responseObserved: true }), /Invalid safe/);
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, size: { kind: "reference-content", measured: 70000, limit: 65536, unit: "bytes", text: secretMarker } }), /Invalid safe/);
});

test("result diagnostics keep unknown historical errors and never retain near-match exception prose", () => {
    const legacy = createEvaluationDiagnostic(new Error(secretMarker), { stage: "result-validation", sendInvoked: true, responseObserved: true });
    assert.equal(validateEvaluationDiagnostic(legacy).errorCode, "unknown-error");
    const diagnostic = createEvaluationDiagnostic(new TypeError("invalid-evidence-anchor: " + secretMarker), {
        stage: "result-validation", sendInvoked: true, responseObserved: true,
    });
    assert.equal(diagnostic.errorCode, "unknown-error");
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secretMarker));
});

test("historical reference-count validation keeps its existing count bound without dropping documents", async t => {
    const f = await evaluationFixture(t), original = f.inputs[0], events = original.events;
    const source = [events[0], events[1]], ids = [];
    for (let i = 0; i < 51; i++) {
        const id = "synthetic-call-" + i; ids.push(id);
        source.push(
            { ...events[2], id: "start-" + i, data: { ...events[2].data, toolCallId: id } },
            { ...events[3], id: "end-" + i, data: { toolCallId: id, success: true, result: { content: "Synthetic", structuredContent: { count: 1 } } } },
        );
    }
    source.push(events[4], events[5]);
    const interactionRef = "interaction-" + "a".repeat(32);
    assert.throws(() => buildEvaluationPacket(source, {
        interactionRef, sourceSessionId: original.record.sourceSessionId, promptEventId: events[1].id,
        promptTimestamp: events[1].timestamp, promptText: events[1].data.content, toolCallIds: ids,
    }, { confirmed: true, interactionRefs: [interactionRef], categories: ["answer", "references", "intent"],
        sourceConfigRef: "sourceconfig-" + "b".repeat(32), sourceConfigRevision: 1 }), error => {
        assert.deepEqual(readEvaluationDiagnostic(error).size, { kind: "references", measured: 102, limit: 100, unit: "items" });
        return error.message === "evidence-limit";
    });
});

test("historical packet size diagnostics retain exact UTF-8 and aggregate limits without source text", async t => {
    for (const kind of ["answer", "reference-content", "reference-structured", "packet"]) {
        const f = await evaluationFixture(t);
        const source = f.inputs[0], answer = source.events.find(event => event.type === "assistant.message");
        const completion = source.events.find(event => event.type === "tool.execution_complete");
        if (kind === "answer") answer.data.content = "\u00e9".repeat(32769);
        if (kind === "reference-content") completion.data.result.content = "x".repeat(65537);
        if (kind === "reference-structured") completion.data.result = { structuredContent: { text: "x".repeat(65537) } };
        if (kind === "packet") {
            source.record.userPrompt.text = "p".repeat(64000); source.events[1].data.content = source.record.userPrompt.text;
            answer.data.content = "a".repeat(64000);
            source.record.toolCalls[0].requestArgs = { text: "g".repeat(64000) };
            source.events[2].data.arguments = source.record.toolCalls[0].requestArgs;
            completion.data.result = { content: "r".repeat(64000), structuredContent: { text: "s".repeat(64000) } };
        }
        const interactionRef = "interaction-" + "a".repeat(32);
        assert.throws(() => buildEvaluationPacket(source.events, {
            interactionRef, sourceSessionId: source.record.sourceSessionId, promptEventId: source.events[1].id,
            promptTimestamp: source.events[1].timestamp, promptText: source.record.userPrompt.text,
            toolCallIds: [source.record.toolCalls[0].toolCallId],
        }, { confirmed: true, interactionRefs: [interactionRef], categories: ["answer", "references", "intent"],
            sourceConfigRef: "sourceconfig-" + "b".repeat(32), sourceConfigRevision: 1 }), error => {
            const diagnostic = readEvaluationDiagnostic(error);
            assert.equal(diagnostic.size.kind, kind);
            assert.ok(diagnostic.size.measured > diagnostic.size.limit);
            assert.equal(diagnostic.size.unit, "bytes");
            assert.equal(diagnostic.size.limit, kind === "packet" ? 262144 : 65536);
            if (kind === "answer") assert.equal(diagnostic.size.measured, 65538);
            assert.equal(diagnostic.sendInvoked, false);
            return error.message === "evidence-limit";
        });
        assert.equal(f.calls.length, 0);
    }
});
