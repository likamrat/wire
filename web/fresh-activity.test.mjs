import test from "node:test";
import assert from "node:assert/strict";
import { createFreshActivity } from "./fresh-activity.mjs";

test("the contextual entry cannot turn an unknown check into a newer successful history check", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.fail(token, "Response lost");
    const context = { approved: true, enabled: true, checked: "just now" };
    assert.equal(flow.entry(context).label, "Local check unconfirmed");
    assert.equal(flow.entry(context).storedOnly, true);
    assert.equal(flow.entry(context).attention, true);
    flow.retryApply();
    assert.equal(flow.entry(context).label, "Reading stored activity...");
    flow.applied(12, "approved", []);
    assert.equal(flow.entry(context).label, "Local check unconfirmed");
    assert.equal(flow.begin(), null);
});

test("the contextual entry distinguishes approved history, paused collection and stored-only reads", () => {
    const flow = createFreshActivity();
    assert.equal(flow.entry({ approved: true, enabled: true, checked: "5 minutes ago" }).label, "History checked 5 minutes ago");
    assert.equal(flow.entry({ approved: true, enabled: false, checked: "5 minutes ago" }).label, "Collection paused");
    assert.equal(flow.entry({ approved: false, checked: "5 minutes ago" }).label, "Stored activity only");
    assert.equal(flow.entry({ approved: true, readError: true }).label, "Stored view not updated");
    assert.equal(flow.entry({ approved: true, readError: true }).storedOnly, true);
    assert.equal(flow.entry({ approved: true, collectionState: "error" }).label, "Local history needs attention");
    flow.begin({ checkSource: false }); flow.applied(4, "approved", []);
    assert.equal(flow.entry({ approved: true, enabled: true, checked: "just now" }).label, "Stored activity read");
});

test("the contextual entry keeps deferred, partial and read-only states distinct", () => {
    const flow = createFreshActivity(), token = flow.begin();
    const context = { approved: true, enabled: false, checked: "just now" };
    flow.collected(token, { schemaVersion: 2, id: "partial", revision: 3, configVersion: "approved",
        completedAt: "2026-10-05T20:00:00Z", outcome: "partial", changes: { added: 0, updated: 0, items: [] },
        coverage: { limited: 1 }, sourcesChecked: 1, eligibleSources: 1 });
    flow.defer();
    assert.equal(flow.entry(context).label, "Activity update waiting");
    assert.equal(flow.entry(context).attention, true);
    flow.applied(3, "approved", []);
    assert.equal(flow.entry(context).label, "Some history is incomplete");
    assert.equal(flow.entry(context).storedOnly, false);
    flow.blockSource("Recovery marker could not be cleared.");
    assert.equal(flow.entry(context).label, "Source checks are read-only");
    assert.equal(flow.entry(context).attention, true);
    assert.equal(flow.entry(context).storedOnly, true);
});

test("a rejected source configuration stays a known failure after a stored-only recovery", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.fail(token, "Choose the Copilot app's absolute data.db path and CLI session-state directory. No other file tree is scanned.",
        { rejected: true, reason: "source_paths_invalid" });
    assert.equal(flow.snapshot().sourceUnknown, false);
    assert.equal(flow.snapshot().message, "Source paths need attention.");
    assert.equal(flow.snapshot().recovery, "source");
    flow.retryApply();
    flow.applied(9, "unchanged-source", []);
    assert.equal(flow.snapshot().sourceUnknown, false);
    assert.equal(flow.snapshot().message, "Source paths need attention.");
    assert.match(flow.snapshot().context, /Stored activity refreshed/);
    assert.doesNotMatch(flow.snapshot().context, /unknown|unconfirmed/);
});

test("only explicit pre-read reasons settle a source failure; unrelated errors remain unknown", () => {
    for (const reason of ["source_paths_invalid", "source_mapping_unsupported", "source_metadata_unavailable", "", "INTERNAL", "EACCES", "runtime_unavailable"]) {
        const flow = createFreshActivity(), token = flow.begin();
        flow.fail(token, "Invented failed response", { reason });
        assert.equal(flow.snapshot().sourceUnknown, !reason.startsWith("source_"));
        assert.equal(flow.snapshot().recovery, reason.startsWith("source_") ? "source" : "stored");
    }
});

test("failed stored recovery cannot erase a source rejection or manufacture an unknown check", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.fail(token, "Invalid saved paths", { reason: "source_paths_invalid", rejected: true });
    flow.applied(9, "same", []);
    assert.equal(flow.snapshot().message, "Source paths need attention.");
    assert.match(flow.snapshot().context, /Stored activity refreshed/);
    flow.retryApply();
    flow.fail(token, "Stored snapshot unavailable");
    assert.equal(flow.snapshot().message, "Stored view not updated.");
    assert.equal(flow.snapshot().recovery, "stored");
    assert.equal(flow.snapshot().sourceUnknown, false);
    flow.retryApply(); flow.applied(9, "same", []);
    assert.equal(flow.snapshot().message, "Source paths need attention.");
    assert.equal(flow.snapshot().recovery, "source");
    const next = flow.begin();
    assert.notEqual(next, token);
    assert.equal(flow.snapshot().sourceFailure, null, "Only a new explicit check replaces the failed source result");
});

test("reading a changed source retires only an obsolete known failure, not an unknown outcome", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.fail(token, "Old paths", { reason: "source_paths_invalid", configVersion: "old" });
    flow.retryApply({ configVersion: "new" }); flow.applied(9, "new", []);
    assert.equal(flow.snapshot().sourceFailure, null);
    assert.equal(flow.snapshot().message, "Stored activity refreshed.");
    assert.equal(flow.snapshot().context, "No source history was checked.");
    const unknown = createFreshActivity(), pending = unknown.begin();
    unknown.fail(pending, "Lost response", { configVersion: "old" });
    unknown.retryApply({ configVersion: "new" }); unknown.applied(9, "new", []);
    assert.equal(unknown.snapshot().sourceUnknown, true);
    assert.equal(unknown.begin(), null);
});

test("an accepted changed-source snapshot retires a known failure without requiring a recovery click", () => {
    for (const storedRecovery of [false, true]) {
        const flow = createFreshActivity(), token = flow.begin();
        flow.fail(token, "Old paths", { reason: "source_paths_invalid", configVersion: "old" });
        if (storedRecovery) { flow.retryApply(); flow.applied(9, "old", []); }
        flow.applied(10, "new", []);
        assert.equal(flow.snapshot().sourceFailure, null);
        assert.equal(flow.snapshot().recovery, null);
        assert.equal(flow.snapshot().message, "Stored activity refreshed.");
        assert.equal(flow.snapshot().context, "No source history was checked.");
    }
});

test("restored pending source status stays read-only after a fresh stored snapshot", () => {
    const flow = createFreshActivity({ sourceUnknown: true });
    assert.equal(flow.begin(), null);
    flow.retryApply();
    flow.applied(12, "approved", []);
    assert.equal(flow.snapshot().phase, "unconfirmed");
    assert.equal(flow.begin(), null);
});

test("a storage safety latch blocks dispatch without denying an already confirmed source receipt", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.collected(token, { schemaVersion: 2, id: "known", revision: 9, configVersion: "approved",
        completedAt: "2026-10-05T20:00:00Z", outcome: "complete", changes: { added: 0, updated: 0, items: [] } });
    flow.blockSource("Recovery marker could not be cleared.");
    flow.applied(9, "approved", []);
    assert.equal(flow.snapshot().message, "No new recorded activity.");
    assert.equal(flow.snapshot().check.id, "known");
    assert.equal(flow.snapshot().sourceUnknown, false);
    assert.equal(flow.snapshot().sourceBlocked, true);
    assert.equal(flow.begin(), null);
});

test("unapproved refresh reads stored evidence without inventing a source receipt or completeness", () => {
    const flow = createFreshActivity(), token = flow.begin({ checkSource: false });
    assert.equal(flow.snapshot().phase, "applying");
    assert.equal(flow.begin(), null);
    assert.equal(flow.snapshot().check, null);
    assert.equal(flow.applied(7, null, []), true);
    assert.equal(flow.snapshot().phase, "complete");
    assert.equal(flow.snapshot().message, "Stored activity refreshed.");
    assert.match(flow.snapshot().context, /No source history was checked/);
    assert.equal(flow.fail(token, "Late read"), false);
});

test("unknown check outcome permits only safe reads, never inferring correlation from a newer revision", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.fail(token, "Response lost");
    assert.equal(flow.snapshot().sourceUnknown, true);
    assert.equal(flow.begin(), null, "A lost receipt is not permission to repeat source work");
    flow.retryApply();
    assert.equal(flow.snapshot().phase, "applying");
    assert.equal(flow.applied(8, "approved", []), true);
    assert.equal(flow.snapshot().phase, "unconfirmed");
    assert.match(flow.snapshot().message, /source check unconfirmed/);
    flow.retryApply();
    flow.applied(10, "changed", []);
    assert.equal(flow.snapshot().check, null);
    assert.match(flow.snapshot().message, /unconfirmed/);
    assert.equal(flow.begin(), null, "Later evidence or a new connection cannot unlock replay");
});

test("a failed stored read can retry without a source check or fabricated source failure", () => {
    const flow = createFreshActivity(), token = flow.begin({ checkSource: false });
    flow.fail(token, "Stored snapshot unavailable");
    assert.equal(flow.snapshot().message, "Stored view not updated.");
    assert.equal(flow.snapshot().sourceUnknown, false);
    flow.retryApply();
    assert.equal(flow.snapshot().phase, "applying");
    assert.equal(flow.applied(9, null, []), true);
    assert.equal(flow.snapshot().phase, "complete");
});

test("safe recovery drops an obsolete confirmed receipt without pretending it applied to a different source", () => {
    const flow = createFreshActivity(), token = flow.begin();
    flow.collected(token, { schemaVersion: 2, id: "old-source", revision: 9, configVersion: "old",
        completedAt: "2026-10-05T20:00:00Z", outcome: "complete", changes: { added: 0, updated: 0, items: [] } });
    flow.fail(token, "Source changed during read");
    flow.retryApply({ configVersion: "new" });
    assert.equal(flow.snapshot().check, null);
    assert.equal(flow.snapshot().phase, "applying");
    flow.applied(10, "new", []);
    assert.equal(flow.snapshot().message, "Stored activity refreshed.");
    assert.equal(flow.snapshot().sourceUnknown, false);
});

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
    flow.fail(old, "Source unavailable", { rejected: true });
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
