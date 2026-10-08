import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { collectionSummary } from "../lib/collector.mjs";
import { createLocalSearch } from "../web/local-search.mjs";

const model = createCollectionStatus();
test("every reason names the history object, impact and next step without claiming automatic repair", () => {
    for (const [code, copy] of Object.entries(model.reasons)) {
        assert.notEqual(copy.label, code);
        assert.match(copy.label, /Copilot chat|request-to-action/);
        assert.ok(copy.explanation.length > 30, code);
        assert.ok(copy.guidance.length > 30, code);
        assert.ok(model.checkSummaries[code]?.length > 30, code);
        assert.ok(model.checkSummaries[code]?.length < 180, `${code}: contextual summary stays concise`);
        assert.doesNotMatch(copy.guidance, /will repair|will recreate|deleted by/i);
        const row = { name: "Synthetic Atlas", sessionId: "synthetic-id", reasons: [code], unavailable: ["missing", "permission", "read", "unsupported", "unknown"].includes(code) };
        assert.ok(createLocalSearch().matches(copy.label, model.searchTerms(row)), code);
    }
    const mixed = { name: "Synthetic Beacon", reasons: ["missing", "truncated", "context"], unavailable: true };
    assert.ok(createLocalSearch().matches("unavailable", model.searchTerms(mixed)));
    assert.ok(!createLocalSearch().matches("limited", model.searchTerms(mixed)));
    const oversized = { name: "Synthetic Cedar", reasons: ["oversized"], unavailable: false };
    assert.ok(createLocalSearch().matches("limited", model.searchTerms(oversized)));
    assert.ok(!createLocalSearch().matches("unavailable", model.searchTerms(oversized)), "A negated explanation must not turn a limited chat into an unavailable search match.");
});
test("local missing history is not an API failure; archived errors are excluded", () => {
    const roster = [
        { sessionId: "missing", name: "Planning", eligible: true },
        { sessionId: "archived", eligible: false, disposition: "archived" },
    ];
    const result = model.coverage(roster, [
        { sessionId: "missing", error: "not found", errorCode: "ENOENT" },
        { sessionId: "archived", error: "not found", errorCode: "ENOENT" },
    ], []);
    assert.equal(result.summary.unavailable, 1);
    assert.equal(result.summary.affected, 1);
    assert.equal(result.summary.excluded.archived, 1);
    assert.deepEqual(result.issues[0].reasons, ["missing"]);
    assert.equal(result.issues[0].hasPriorEvidence, false);
    assert.equal(result.issues[0].lastAttemptAt, null);
    assert.doesNotMatch(JSON.stringify(result), /HTTP|authentication|Graph request failed/);
});

test("routine status omits personal issue rows and raw cursor diagnostics", () => {
    const summary = collectionSummary({ revision: 3, historyCoverage: { unavailable: 1 },
        historyIssues: [{ name: "PRIVATE_NAME" }], cursors: [{ error: "PRIVATE_ERROR" }],
        discovery: { roster: [{ name: "PRIVATE_NAME" }], unmappedWorkspaces: [{ name: "PRIVATE_NAME" }], counts: { eligible: 1 } } });
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_NAME|PRIVATE_ERROR/);
    assert.equal(summary.historyCoverage.unavailable, 1);
});

test("status distinguishes healthy, paused, first setup, pending import and blocking failure", () => {
    const status = { state: "collecting-on-interval", config: { enabled: true }, discovery: {}, historyCoverage: { eligible: 10, unavailable: 0, limited: 0, pending: 0 }, lastCheckedAt: "2026-10-05T01:00:00Z" };
    assert.equal(model.view(status).label, "Collection active");
    assert.equal(model.view({ ...status, state: "paused" }).label, "Collection paused");
    assert.equal(model.view({ state: "disconnected" }).label, "Set up collection");
    assert.equal(model.view({ ...status, historyCoverage: { ...status.historyCoverage, pending: 2 } }).label, "Importing history");
    assert.equal(model.view({ ...status, state: "collecting" }).label, "Checking history");
    assert.equal(model.view({ ...status, state: "error", error: "unsupported" }).severity, "error");
    assert.equal(model.view({ ...status, historyCoverage: { ...status.historyCoverage, unavailable: 2 } }).severity, "warning");
    assert.equal(model.view({ ...status, historyCoverage: { ...status.historyCoverage, unavailable: 10 } }).label, "History unavailable");
    assert.equal(model.view({ ...status, discovery: null }).label, "Checking history");
    assert.equal(model.view({ ...status, historyCoverage: { eligible: 0 } }).label, "No local Copilot chats to collect");
});

test("entry notices reserve attention for setup, pause, initial import and current blocking failures", () => {
    const healthy = { state: "collecting-on-interval", config: { approved: true, enabled: true }, discovery: {},
        historyCoverage: { eligible: 10, unavailable: 0, limited: 0, pending: 0 }, lastCheckedAt: "2026-10-05T01:00:00Z" };
    assert.equal(model.entry(healthy, { hasEvidence: true }), null);
    assert.equal(model.entry({ ...healthy, state: "collecting" }, { hasEvidence: true }), null);
    assert.equal(model.entry({ ...healthy, historyCoverage: { ...healthy.historyCoverage, unavailable: 2, limited: 3 } }, { hasEvidence: true }), null);
    assert.equal(model.entry({ ...healthy, historyCoverage: { ...healthy.historyCoverage, pending: 2 } }, { hasEvidence: true }), null);
    assert.match(model.entry({ state: "disconnected", config: null }).text, /Connect local Copilot chats/);
    assert.match(model.entry({ state: "disconnected", config: null }).action, /Review source/);
    assert.match(model.entry(healthy, { unavailable: true, hasEvidence: true }).text, /unavailable.*Retry.*last accepted view/);
    const offline = model.entry(healthy, { unavailable: true, reason: "runtime_unavailable" });
    assert.match(offline.text, /Local runtime unavailable.*Start WIRE/);
    assert.doesNotMatch(offline.text, /retained evidence|accepted view/i);
    assert.match(model.entry({ ...healthy, state: "paused" }, { hasEvidence: true }).text, /paused.*Retained evidence/);
    assert.match(model.entry({ ...healthy, discovery: null }).text, /Reading approved Copilot chat history/);
    assert.match(model.entry({ ...healthy, historyCoverage: { eligible: 0 } }).text, /No verified local Copilot chat histories/);
    const error = model.entry({ ...healthy, error: "Synthetic private path failure" }, { hasEvidence: true });
    assert.equal(error.severity, "error");
    assert.match(error.text, /cannot check.*Retained evidence/);
    assert.doesNotMatch(error.text, /Synthetic private/);
    const unreadable = model.entry({ ...healthy, historyCoverage: { ...healthy.historyCoverage, unavailable: 10 } });
    assert.equal(unreadable.severity, "error");
    assert.equal(unreadable.issues, true);
    assert.match(unreadable.action, /View history issues/);
    assert.equal(model.entry({ ...healthy, state: "stopped" }).severity, "error");
});

test("specific reasons, exclusions and overlapping limits reconcile by unique session", () => {
    const rows = [
        { sessionId: "missing", error: "x", errorCode: "ENOENT", cursor: { droppedBytes: 10, oversizedLines: 2 } },
        { sessionId: "permission", error: "x", errorCode: "EACCES" },
        { sessionId: "read", error: "x", errorCode: "EIO" },
        { sessionId: "unsupported", error: "x", errorCode: "HISTORY_IDENTITY_UNSUPPORTED" },
        { sessionId: "unknown", error: "SECRET_PATH token=private HTTP 401" },
        { sessionId: "limits", scanned: true, cursor: { droppedBytes: 10, malformedLines: 3, oversizedLines: 1 }, diagnostics: { contextEvictions: 2 } },
        { sessionId: "context", scanned: true, diagnostics: { contextEvictions: 2 } },
        { sessionId: "privacy", scanned: true, diagnostics: { credentialExclusions: 9 } },
        { sessionId: "partial", scanned: true, cursor: { backlogBytes: 12, partialBytes: 12 } },
        { sessionId: "backfill", scanned: true, cursor: { backlogBytes: 24, partialBytes: 0 } },
    ];
    const roster = [...rows.map(r => ({ sessionId: r.sessionId, name: "Synthetic session", eligible: true })),
        { sessionId: "new", eligible: true },
        ...["archived", "nonlocal-not-read", "unmapped-workspace-session"].map(disposition => ({ sessionId: disposition, disposition, eligible: false }))];
    const result = model.coverage([...roster, roster[0]], rows, ["missing"]);
    assert.deepEqual(result.summary, { eligible: 11, readable: 5, pending: 2, unavailable: 5, limited: 2, affected: 7,
        groups: { missing: 1, permission: 1, read: 1, unsupported: 1, unknown: 1, truncated: 1, context: 1 },
        excluded: { archived: 1, "nonlocal-not-read": 1, "unmapped-workspace-session": 1 } });
    assert.equal(Object.values(result.summary.groups).reduce((a, b) => a + b), result.issues.length);
    assert.equal(result.issues[0].hasPriorEvidence, true);
    assert.deepEqual(result.issues[0].reasons, ["missing", "truncated", "oversized"]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_PATH|private|401/);
    assert.equal(model.coverage().summary.affected, 0);
    assert.deepEqual(model.coverage().issues, []);
});
