import test from "node:test";
import assert from "node:assert/strict";
import { createFreshActivity } from "./fresh-activity.mjs";

test("a check completes only after its committed revision is applied; excluded changes stay explicit", () => {
    const flow = createFreshActivity(), token = flow.begin();
    assert.equal(flow.snapshot().phase, "checking");
    assert.equal(flow.begin(), null, "Double submit never starts another check");
    const check = { schemaVersion: 2, id: "check-one", beforeRevision: 7, revision: 8, configVersion: "approved", completedAt: "2026-10-05T20:00:00Z",
        outcome: "complete", changes: { added: 1, updated: 0, items: [{ kind: "tool", sourceSessionId: "one", id: "call" }] },
        coverage: {}, pendingSources: 0, partialSources: 0, skippedSources: 0, sourcesChecked: 1, eligibleSources: 1 };
    assert.throws(() => flow.collected(token, { ...check, beforeRevision: 8 }), /without a newer committed revision/);
    flow.collected(token, check);
    assert.equal(flow.snapshot().phase, "applying");
    assert.equal(flow.applied(7, "approved", []), false);
    assert.equal(flow.snapshot().phase, "applying");
    assert.equal(flow.applied(8, "approved", []), true);
    assert.equal(flow.snapshot().phase, "complete");
    assert.equal(flow.snapshot().message, "1 new activity record.");
    assert.match(flow.snapshot().context, /outside.*filters or evidence layer/);
    assert.equal(flow.applied(9, "approved", [{ sourceSessionId: "one", toolCallId: "call" }]), true);
    assert.equal(flow.snapshot().context, "", "Completed check context follows subsequently applied filters");
    assert.equal(flow.applied(10, "different-approved-config", []), false);
    assert.equal(flow.snapshot().phase, "idle");
    assert.match(flow.snapshot().message, /settings changed/);
});

test("late failures cannot overwrite a newer check and failed reads never claim applied success", () => {
    const flow = createFreshActivity(), old = flow.begin();
    flow.fail(old, "Source unavailable");
    assert.equal(flow.snapshot().phase, "error");
    const current = flow.begin();
    assert.notEqual(current, old);
    assert.equal(flow.fail(old, "Late error"), false);
    assert.equal(flow.snapshot().phase, "checking");
    flow.collected(current, { schemaVersion: 2, id: "new", revision: 9, configVersion: "approved", completedAt: "2026-10-05T20:00:00Z",
        outcome: "partial", changes: { added: 0, updated: 0, items: [] }, coverage: { unavailable: 1 } });
    flow.defer();
    assert.match(flow.snapshot().context, /Close.*review/);
    assert.equal(flow.snapshot().phase, "waiting");
    assert.equal(flow.busy(), true);
    flow.retryApply();
    assert.equal(flow.snapshot().phase, "applying");
    flow.fail(current, "Snapshot read failed");
    assert.match(flow.snapshot().message, /not updated/);
    assert.match(flow.snapshot().context, /Snapshot read failed/);
    assert.equal(flow.applied(9, "approved", []), false);
});

test("novelty and partial coverage are separate facts, without claiming a complete source read", () => {
    const flow = createFreshActivity(), token = flow.begin();
    const check = { schemaVersion: 2, id: "partial", beforeRevision: 8, revision: 8, configVersion: "approved",
        startedAt: "2026-10-05T20:00:00.000Z", completedAt: "2026-10-05T20:00:00.012Z",
        outcome: "partial", changes: { added: 0, updated: 0, items: [] }, coverage: { unavailable: 19, limited: 62 },
        sourcesChecked: 90, eligibleSources: 90, pendingSources: 0, partialSources: 0, skippedSources: 0 };
    flow.collected(token, check); flow.applied(8, "approved", []);
    assert.equal(flow.snapshot().message, "No new recorded activity.");
    assert.equal(flow.snapshot().coverage, "Chat history: 19 unavailable · 62 with limits");
    assert.match(flow.snapshot().details, /90 of 90 eligible Copilot chats in 12 ms/);
    assert.match(flow.snapshot().details, /19 histories unavailable; 62 with limits/);
    assert.doesNotMatch(flow.snapshot().message, /up to date|view updated|Partial|19|62/);
    assert.equal(flow.snapshot().check.completedAt, check.completedAt);
    flow.applied(10, "approved", []);
    assert.equal(flow.snapshot().check.completedAt, check.completedAt, "Later accepted snapshots cannot replace the manual check time");
});

test("partial summaries name only known chat coverage categories and keep exclusions separate", () => {
    const base = { schemaVersion: 2, id: "scope", beforeRevision: 8, revision: 8, configVersion: "approved",
        startedAt: "2026-10-05T20:00:00Z", completedAt: "2026-10-05T20:00:01Z",
        outcome: "partial", changes: { added: 0, updated: 0, items: [] },
        sourcesChecked: 3, eligibleSources: 3, pendingSources: 0, partialSources: 0, skippedSources: 0 };
    for (const [changes, expected] of [
        [{ coverage: { unavailable: 1 } }, "Chat history: 1 unavailable"],
        [{ coverage: { limited: 2 } }, "Chat history: 2 with limits"],
        [{ coverage: {}, pendingSources: 2 }, "Chat history: 2 still reading"],
        [{ coverage: {}, partialSources: 1 }, "Chat history: 1 awaiting a saved entry"],
        [{ coverage: {}, skippedSources: 4 }, "Chat history: 4 beyond the discovery limit"],
        [{ coverage: {}, sourcesChecked: 1 }, "Chat history: 2 not checked this cycle"],
        [{ coverage: { unavailable: 0, limited: 0, excluded: { archived: 10 } } }, "History coverage incomplete"],
    ]) {
        const flow = createFreshActivity(), token = flow.begin();
        flow.collected(token, { ...base, ...changes }); flow.applied(8, "approved", []);
        assert.equal(flow.snapshot().coverage, expected);
        assert.equal(flow.snapshot().message, "No new recorded activity.");
        assert.doesNotMatch(flow.snapshot().coverage, /failed|archived|10/);
    }
    const flow = createFreshActivity(), token = flow.begin();
    flow.collected(token, { ...base, outcome: "complete", sourcesChecked: 0, eligibleSources: 0, coverage: { excluded: { archived: 10 } } });
    flow.applied(8, "approved", []);
    assert.equal(flow.snapshot().coverage, "");
    assert.match(flow.snapshot().details, /No eligible local chats/);
    assert.doesNotMatch(flow.snapshot().details, /complete history|all history/);
});

test("same-count metadata updates use canonical row and parent identities for current-scope feedback", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.collected(token, { schemaVersion: 2, id: "metadata", beforeRevision: 8, revision: 9, configVersion: "approved",
        completedAt: "2026-10-05T20:00:00Z", outcome: "complete",
        changes: { added: 0, updated: 1, items: [{ kind: "tool", rowId: "canonical", id: "legacy", sourceSessionId: "one" }] } });
    flow.applied(9, "approved", [{ id: "api-row", parentCallId: "canonical" }]);
    assert.equal(flow.snapshot().message, "1 updated activity record.");
    assert.equal(flow.snapshot().context, "");
    flow.applied(9, "approved", []);
    assert.match(flow.snapshot().context, /outside/);
});
