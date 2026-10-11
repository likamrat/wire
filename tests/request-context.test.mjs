import test from "node:test";
import assert from "node:assert/strict";
import { createRequestContext } from "../web/request-context.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";

test("source-derived adjacency exposes changed requests without claiming a task or complete chat", () => {
    const { records } = retainedContextFixture(), before = structuredClone(records), reader = createRequestContext();
    assert.equal(records[0].followUpPrompts.length, 1);
    assert.match(records[0].followUpPrompts[0].association, /inferred, not confirmed/);
    assert.equal(records[1].responseTiming.respondedAt, "2026-09-30T12:00:07Z");
    assert.equal(records[1].toolCalls[0].toolSucceeded, true);
    const context = reader.select(records, records[0].scenarioId);
    assert.deepEqual(context.groups.map(group => group.scenario.scenarioId), records.slice(0, 2).map(record => record.scenarioId));
    assert.deepEqual(context.messages.map(message => message.source.sourceEventId), ["five", "three"],
        "A neighboring group's follow-ups do not extend the one-hop boundary");
    assert.match(context.boundary, /at most one linked group/);
    assert.deepEqual(records, before, "Selection does not mutate source or historical verdicts");
    const fromReply = reader.select(records, records[1].scenarioId);
    assert.deepEqual(fromReply.groups.map(group => group.relation), ["preceding", "selected", "following"]);
    assert.equal(fromReply.groups.some(group => group.scenario.scenarioId === records[3].scenarioId), false);
});

test("missing, ambiguous, cross-chat and conflicting links do not silently widen context", () => {
    const { records } = retainedContextFixture(), reader = createRequestContext();
    const anchor = records[0], next = records[1];
    for (const neighbor of [
        { ...next, sourceSessionId: "different-chat" },
        { ...next, userPrompt: { ...next.userPrompt, sourceEventId: "different-message" } },
    ]) assert.equal(reader.select([anchor, neighbor], anchor.scenarioId).groups.length, 1);
    for (const timestamp of [undefined, "not-a-date", "2026-09-30T11:00:00Z"]) {
        const context = reader.select([anchor, { ...next, userPrompt: { ...next.userPrompt, sourceTimestamp: timestamp } }], anchor.scenarioId);
        assert.equal(context.groups.length, 1);
        assert.match(context.gaps[0], /missing or conflicting chronology/);
    }
    const ambiguous = reader.select([anchor, next, { ...next, scenarioId: "ambiguous-copy" }], anchor.scenarioId);
    assert.equal(ambiguous.groups.length, 1);
    assert.match(ambiguous.gaps[0], /Multiple retained groups/);
    assert.equal(reader.select(records, "missing").groups.length, 0);
    const sameInstant = { ...anchor, userPrompt: { ...anchor.userPrompt, sourceTimestamp: next.userPrompt.sourceTimestamp } };
    assert.equal(reader.select([sameInstant, next], sameInstant.scenarioId).groups.length, 2,
        "A recorded following-message link can establish adjacency when timestamps tie");
});

test("selection preserves exact text states and authorship; unknown timestamps are not invented", () => {
    const { records } = retainedContextFixture(), reader = createRequestContext();
    records[0].userPrompt = { ...records[0].userPrompt, status: "partial", text: "  Exact\r\nfragment  ",
        authorship: { actor: "agent", basis: "source-agent" } };
    records[0].followUpPrompts.push({ status: "unavailable", sourceEventId: "missing", authorship: { actor: "unknown", basis: "missing-source" } });
    const context = reader.select([records[0]], records[0].scenarioId);
    assert.equal(context.messages[0].source, records[0].userPrompt);
    assert.deepEqual(context.messages[0].source.authorship, { actor: "agent", basis: "source-agent" });
    assert.equal(context.messages.at(-1).source.status, "unavailable");
    assert.equal(context.messages.at(-1).key, `followup:${records[0].scenarioId}:missing`);
    assert.equal(reader.compare({ at: undefined }, { at: undefined }), 0);
    assert.ok(reader.compare({ at: undefined }, { at: records[0].capturedAt }) > 0);
});
