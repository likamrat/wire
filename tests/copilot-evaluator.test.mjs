import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createCopilotEvaluator, evaluatorFailureCost } from "../lib/copilot-evaluator.mjs";
import { createEvaluationRequest } from "../lib/model-evaluation.mjs";
import { buildEvaluationPacket } from "../lib/evaluation-evidence.mjs";

function request() {
    const ref = "interaction-" + "a".repeat(32), source = "sourceconfig-" + "b".repeat(32);
    const events = [
        { type: "user.message", data: { content: "Synthetic request" } },
        { type: "assistant.message", data: { content: "Synthetic response", phase: "final_answer", turnId: "t" } },
        { type: "assistant.turn_end", data: { turnId: "t" } },
    ].map((event, index) => ({ ...event, id: `event-${index}`, timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString() }));
    const packet = buildEvaluationPacket(events, { interactionRef: ref, sourceSessionId: "source", promptEventId: events[0].id,
        promptTimestamp: events[0].timestamp, promptText: events[0].data.content, toolCallIds: [] },
    { confirmed: true, interactionRefs: [ref], sourceConfigRef: source, sourceConfigRevision: 1, categories: ["answer", "references", "usage", "intent"] });
    return createEvaluationRequest(packet, { confirmed: true, provider: "github-copilot", model: "approved-model",
        maxCalls: 6, maxAiCredits: 60, interactionRefs: [ref], sourceConfigRef: source, sourceConfigRevision: 1 });
}
const baseDirectory = path.join(os.tmpdir(), "wire-evaluator-fixture");
function fixture() {
    const calls = [], events = new Set();
    let config, throws = false;
    const session = {
        on(handler) { events.add(handler); return () => events.delete(handler); },
        async sendAndWait(message) {
            calls.push(["send", message]);
            if (throws) throw new Error("Synthetic uncertain response");
            for (const handler of events) handler({ type: "assistant.usage", data: { apiCallId: "call-1", model: "approved-model", copilotUsage: { totalNanoAiu: 100000000 } } });
            return { type: "assistant.message", data: { content: '{"result":"synthetic"}' } };
        },
        async disconnect() { calls.push(["close"]); },
        async abort() { calls.push(["abort"]); },
    };
    const client = {
        async createSession(value) {
            assert.ok(value.sessionLimits.maxAiCredits >= 30, "Synthetic SDK enforces the observed runtime minimum.");
            config = value; calls.push(["create"]); return session;
        },
        async stop() { calls.push(["stop"]); },
    };
    return { calls, client, session, events, get config() { return config; }, set throws(value) { throws = value; } };
}

test("evaluator creates no host/session without explicit executor authority and a durable budget reservation", async () => {
    const f = fixture();
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => { f.calls.push(["client"]); return f.client; } });
    await assert.rejects(evaluator.evaluate(request(), null), /evaluator-execution-not-approved/);
    assert.deepEqual(f.calls, []);
});

test("approved execution uses empty tool set, no inherited instructions or hooks, one model send and separate judge cost", async () => {
    const f = fixture();
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: options => { f.calls.push(["client", options]); return f.client; } });
    const result = await evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 60, callsRemaining: 1,
    });
    assert.deepEqual(f.calls[0][1], { mode: "empty", autoStart: true, baseDirectory, useLoggedInUser: true });
    assert.deepEqual(f.config.availableTools, []);
    assert.deepEqual(f.config.excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
    assert.equal(f.config.skipCustomInstructions, true);
    assert.equal(f.config.infiniteSessions.enabled, false);
    assert.equal(f.config.memory.enabled, false);
    assert.deepEqual(f.config.sessionLimits, { maxAiCredits: 60 });
    assert.equal(f.config.systemMessage.mode, "replace");
    assert.equal(f.config.onPermissionRequest({}).kind, "denied-no-approval-rule-and-could-not-request-from-user");
    assert.equal(f.calls.filter(([name]) => name === "send").length, 1);
    assert.equal(result.evaluatorCost.aiCredits, 0.1);
    assert.equal(result.evaluatorCost.attribution, "evaluation-overhead-only");
    assert.equal(result.reservationId, "reservation-1");
});

test("uncertain provider response is never replayed and always cleans up the owned session/client", async () => {
    const f = fixture(); f.throws = true;
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    await assert.rejects(evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 60, callsRemaining: 1,
    }), /Synthetic uncertain response/);
    assert.equal(f.calls.filter(([name]) => name === "send").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "close").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "stop").length, 1);
});

test("a denied final authority gate creates and drains the configured session without invoking send", async () => {
    const f = fixture();
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    await assert.rejects(evaluator.evaluate(request(), {
        confirmed: true, reservationId: "synthetic-no-send", remainingAiCredits: 30, callsRemaining: 1,
    }, { authorize: () => { throw new Error("permission-revoked"); } }), /permission-revoked/);
    assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "send").length, 0);
    assert.equal(f.calls.filter(([name]) => name === "abort").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "close").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "stop").length, 1);
    assert.equal(f.events.size, 0);
});

test("invalid result and observed tool execution are explicit failures, not trusted success", async () => {
    const f = fixture();
    f.session.sendAndWait = async () => {
        for (const handler of f.events) handler({ type: "tool.execution_start", data: { toolCallId: "unexpected" } });
        return { data: { content: "{}" } };
    };
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    await assert.rejects(evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 30, callsRemaining: 1,
    }), /evaluator-tool-execution/);
});

test("SDK-returned cleanup errors are not silently treated as a successful evaluation", async () => {
    const f = fixture();
    f.client.stop = async () => [new Error("Synthetic cleanup failure")];
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    await assert.rejects(evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 60, callsRemaining: 1,
    }), /cleanup failed/);
});

test("one abort cancels an in-flight request and removes the listener before cleanup completes", async () => {
    const f = fixture();
    let rejectSend;
    f.session.sendAndWait = () => new Promise((_, reject) => { f.calls.push(["send"]); rejectSend = reject; });
    f.session.abort = async () => { f.calls.push(["abort"]); rejectSend(new Error("Synthetic cancellation")); };
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client }), cancellation = new AbortController();
    const result = evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 30, callsRemaining: 1,
    }, { signal: cancellation.signal });
    await new Promise(resolve => setImmediate(resolve));
    cancellation.abort();
    await assert.rejects(result, /Synthetic cancellation/);
    assert.equal(f.calls.filter(([name]) => name === "abort").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "close").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "stop").length, 1);
});

test("missing optional billing preserves a response for validation but records unknown overhead", async () => {
    const f = fixture();
    f.session.sendAndWait = async () => {
        for (const handler of f.events) handler({ type: "assistant.usage", data: { apiCallId: "call-1", model: "approved-model" } });
        return { type: "assistant.message", data: { content: "{}" } };
    };
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    const result = await evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 30, callsRemaining: 1,
    });
    assert.equal(result.evaluatorCost.aiCredits, null);
    assert.equal(result.evaluatorCost.status, "unavailable");
    assert.equal(result.evaluatorCost.modelCalls, 1);
    assert.deepEqual(result.rawResult, {});
});

test("no usage events do not manufacture zero model calls or zero cost", async () => {
    const f = fixture();
    f.session.sendAndWait = async () => ({ type: "assistant.message", data: { content: "{}" } });
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    const result = await evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 30, callsRemaining: 1,
    });
    assert.equal(result.evaluatorCost.aiCredits, null);
    assert.equal(result.evaluatorCost.modelCalls, null);
});

test("failure billing accepts only observed adapter usage, excludes conflicting calls and preserves other known charges", async () => {
    assert.equal(evaluatorFailureCost(Object.assign(new Error("Untrusted failure"), { evaluatorCost: { aiCredits: 100 } })), null);
    const f = fixture();
    f.session.sendAndWait = async () => {
        for (const [apiCallId, amount] of [["conflicted", 100000000], ["conflicted", 200000000], ["conflicted", 100000000], ["known", 300000000]]) {
            for (const handler of f.events) handler({ type: "assistant.usage", data: {
                apiCallId, model: "approved-model", copilotUsage: { totalNanoAiu: amount },
            } });
        }
        return { type: "assistant.message", data: { content: "{}" } };
    };
    const evaluator = createCopilotEvaluator({ baseDirectory, createClient: () => f.client });
    await assert.rejects(evaluator.evaluate(request(), {
        confirmed: true, reservationId: "reservation-1", remainingAiCredits: 30, callsRemaining: 1,
    }), error => {
        const cost = evaluatorFailureCost(error);
        assert.equal(cost.aiCredits, 0.3);
        assert.equal(cost.status, "partial");
        cost.aiCredits = 900;
        assert.equal(evaluatorFailureCost(error).aiCredits, 0.3);
        return /evaluator-usage-conflict/.test(error.message);
    });
});
