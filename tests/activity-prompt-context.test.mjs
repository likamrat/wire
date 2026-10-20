import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { privateFixture } from "./helpers.mjs";

const textAccess = createTextAccess(undefined, undefined, promptAuthorship);

function events(content = "") {
    return [
        { id: "prior-prompt", type: "user.message", timestamp: "2026-10-18T12:00:00Z",
            data: { content: "Invented neighboring request, not the continuation prompt.", source: "user" } },
        { id: "automatic-prompt", type: "user.message", timestamp: "2026-10-18T12:01:00Z",
            data: { content, isAutopilotContinuation: true } },
        { id: "retrieve-start", type: "tool.execution_start", timestamp: "2026-10-18T12:01:01Z",
            data: { toolName: "workiq-retrieve", toolCallId: "retrieve-call", arguments: { query: "Invented tool arguments, not a prompt." } } },
        { id: "retrieve-end", type: "tool.execution_complete", timestamp: "2026-10-18T12:01:02Z",
            data: { toolCallId: "retrieve-call", success: false } },
        { id: "following-prompt", type: "user.message", timestamp: "2026-10-18T12:02:00Z",
            data: { content: "Invented following request, also not the continuation prompt.", source: "user" } },
    ];
}

test("empty automatic message survives retained-event, snapshot and reader projection without substituted text", async t => {
    const counts = { credentialExclusions: 0 };
    const retained = events().map(event => retainEvent(event, counts)).filter(Boolean);
    const extracted = extractScenarios(retained, { sessionId: "synthetic-continuation" },
        "2026-10-18T00:00:00Z", "2026-10-19T00:00:00Z").scenarios;
    assert.equal(extracted.length, 1);
    const { context } = await privateFixture(t, extracted);
    const state = await loadBoardState(context);
    const snapshot = await currentStatePayload(context, state);
    const record = snapshot.scenarios[0];
    const selected = createRequestContext().select(snapshot.scenarios, record.scenarioId)
        .messages.find(message => message.relation === "selected" && message.kind === "prompt");
    assert.equal(counts.credentialExclusions, 0);
    for (const source of [extracted[0].userPrompt, record.userPrompt, selected.source]) {
        assert.equal(source.text, "");
        assert.equal(source.status, "full", "The legacy status describes the retained string, not whether it has words.");
        assert.equal(source.sourceEventId, "automatic-prompt");
        assert.deepEqual(source.authorship, { actor: "agent", basis: "autopilot" });
        assert.deepEqual(textAccess.describePrompt(source), { hasText: false, label: "Automatic continuation",
            notice: "No new message was sent." });
    }
    assert.deepEqual(await loadBoardState(context), state, "Presentation must not rewrite retention or provenance.");
});

test("availability respects authorized text, partial retention and unavailable permission states", () => {
    const automatic = { status: "full", text: "", authorship: { actor: "agent", basis: "autopilot" } };
    assert.deepEqual(textAccess.describePrompt({ ...automatic, text: " \n " }),
        { hasText: false, label: "Automatic continuation", notice: "No new message was sent." });
    for (const status of ["full", "partial", "truncated"]) {
        const source = { ...automatic, status, text: "Retained automatic instruction." };
        assert.equal(textAccess.describePrompt(source).hasText, true);
        assert.equal(textAccess.describePrompt(source).label, "Agent prompt");
        assert.equal(textAccess.excerpt(source), source.text);
    }
    for (const text of [null, "", "This text must not bypass unavailable status."]) {
        assert.deepEqual(textAccess.describePrompt({ ...automatic, text, status: "unavailable" }),
            { hasText: false, label: "Agent activity", notice: "Prompt text unavailable" });
    }
    assert.deepEqual(textAccess.describePrompt({ text: "", status: "full", authorship: { actor: "unknown", basis: "conflicting-source" } }),
        { hasText: false, label: "Author unverified", notice: "No prompt text retained" });
});
