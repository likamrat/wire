import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { collectionSummary } from "../lib/collector.mjs";
import { createLocalSearch } from "../web/local-search.mjs";

const model = createCollectionStatus();
test("global collection pause is recognized without admitting collection or unknown status codes", () => {
    const nativePersistence = {
        schemaVersion: 1, kind: "native-screened-retention", contractVersion: "m365-native-screened-observations-v1",
        rawWriterAdmission: "withheld", configured: true, accountRef: "invented-account-partition",
        generation: 2, revision: 8, actions: [], blockers: ["NATIVE_RETENTION_GLOBAL_PAUSED"],
        configuration: { configurationRevision: 1, privacyRevision: 1,
            policy: "native-screened-source-observations-v1", settings: { paused: false, windowDays: 30 },
            surfaces: ["chat", "cowork"] },
        receipt: null, receiptQuery: null,
    };
    assert.equal(model.persistence({ nativePersistence }), nativePersistence);
    assert.equal(model.persistenceReason({ nativePersistence }), "Collection is paused.");
    assert.throws(() => model.persistence({ nativePersistence: { ...nativePersistence, actions: ["collect-now"] } }),
        /actions conflict/);
    assert.throws(() => model.persistence({ nativePersistence: { ...nativePersistence, blockers: ["UNKNOWN_PAUSE"] } }),
        /saving status is invalid/);
});

test("source notices omit healthy narration and keep uncertain or stopped collection actionable", () => {
    const sources = { global: { state: "committed", paused: false }, github: { status: { state: "collecting-on-interval", config: { approved: true } } },
        microsoft: { status: { configured: true, configuration: { settings: { paused: false } }, blockers: [] } } };
    const current = { current: true, actions: { microsoft: ["collect-now"] } };
    assert.equal(model.sourceEntry(sources, current, { microsoftState: "connected" }), null);
    for (const [blocker, text] of [
        ["NATIVE_RETENTION_OPERATION_UNKNOWN", "Microsoft collection is unconfirmed."],
        ["NATIVE_RETENTION_AUTOMATIC_STOPPED", "Automatic Microsoft collection stopped after an error."],
    ]) {
        sources.microsoft.status.blockers = [blocker];
        const notice = model.sourceEntry(sources, current, { microsoftState: "connected" });
        assert.equal(notice.text, text + " Start a new collection in Settings.");
        assert.equal(notice.severity, "warning");
        assert.equal(notice.href, "#settings?section=connection&setting=microsoft-collection");
        assert.doesNotMatch(notice.text, /ready|enabled|Showing saved activity|connected\./);
        const withheld = model.sourceEntry(sources, { ...current, actions: { microsoft: [] } }, { microsoftState: "connected" });
        assert.doesNotMatch(withheld.text, /Start a new collection/);
        assert.match(withheld.text, /Check its (status|connection) in Settings/);
    }
    sources.global.paused = true;
    assert.equal(model.sourceEntry(sources, current, { microsoftState: "connected" }).text, "Collection is paused.");
    const stale = model.sourceEntry(sources, { ...current, current: false }, { microsoftState: "connected" });
    assert.equal(stale.text, "Collection status unavailable. Refresh to try again.");
});

test("source notices consolidate missing setup without claiming an unavailable account is connected", () => {
    const sources = { global: { state: "legacy-compatible" }, github: { status: { config: null } },
        microsoft: { status: { kind: "native-account-unavailable", configured: false, blockers: ["NATIVE_RETENTION_ACCOUNT_UNAVAILABLE"] } } };
    const current = { current: true, actions: { microsoft: [] } };
    assert.equal(model.sourceEntry(sources, current).text, "Connect a source in Settings.");
    sources.github.status.config = { approved: true };
    assert.equal(model.sourceEntry(sources, current).text, "Microsoft 365 is not connected.");
    assert.equal(model.sourceEntry(sources, current, { githubFailure: "GitHub history is unavailable." }).text,
        "Microsoft 365 is not connected. GitHub history is unavailable.");
});

for (const [name, progress, meaning] of [
    ["pending", { pending: 1 }, /More history remains to be read/],
    ["unfinished", { unfinished: 1 }, /Copilot.*saving/],
    ["unknown progress", { pending: null }, /couldn't confirm whether all history was read/],
    ["unchecked", { unchecked: 1 }, /More history remains to be read/],
    ["skipped", { skipped: 1 }, /Some chats were not checked/],
]) test(`context-only gaps retain their cause with ${name}`, () => {
    const options = { pending: 0, unfinished: 0, unchecked: 0, skipped: 0, enabled: true, ...progress };
    const result = model.impact({ unavailable: 0, limited: 3, affected: 3, groups: { context: 3 } }, options);
    assert.match(result.explanation, /Some prompts may not be linked to their actions or results/);
    assert.match(result.explanation, meaning);
    assert.doesNotMatch(result.explanation, /couldn't be read|couldn't be fully included|couldn't be collected/);
    if (name === "pending" || name === "unchecked" || name === "unfinished") {
        assert.match(result.guidance, /does not guarantee.*prompt-to-action links.*restored/);
    }
    assert.equal(result.action.label, "See currently affected chats");
    assert.equal(result.action.href, "#collection-status?setting=issues");
});

test("history impact explains omitted activity, disconnected links and useful next actions without invented repair", () => {
    const actualShape = { eligible: 1158, readable: 1139, unavailable: 19, limited: 101, affected: 120, pending: 0,
        groups: { missing: 19, truncated: 16, oversized: 28, context: 57 } };
    const mixed = model.impact(actualShape);
    assert.deepEqual(mixed, {
        explanation: "Some activity or links between prompts and actions may be missing from WIRE because parts of chat history couldn't be read.",
        guidance: "Repeating Refresh alone won't fix these gaps. Collected activity is kept.",
        action: { label: "See currently affected chats", href: "#collection-status?setting=issues" },
    });
    assert.match(mixed.explanation, /activity or links between prompts and actions may be missing/i);
    assert.match(mixed.guidance, /Repeating Refresh alone won't fix.*Collected activity is kept/);
    assert.equal(mixed.action.label, "See currently affected chats");
    assert.doesNotMatch(JSON.stringify(mixed), /up to date|everything|fix.*path|complete history|no action is needed/i);
    const links = model.impact({ unavailable: 0, limited: 3, pending: 0, groups: { context: 3 } });
    assert.match(links.explanation, /prompts.*actions or results/);
    assert.match(links.guidance, /does not mean.*failed/);
    assert.doesNotMatch(links.explanation, /couldn't be read|activity.*missing/);
    const unclassified = model.impact({ unavailable: 0, limited: 3, groups: { context: 2 } });
    assert.match(unclassified.explanation, /activity may be missing/i);
    assert.doesNotMatch(unclassified.guidance, /won't fix|won't repair|automatically/);
    const pending = model.impact({ pending: 2 }, { enabled: true });
    assert.match(pending.explanation, /didn't finish reading/);
    assert.match(pending.guidance, /Automatic checks can continue/);
    assert.equal(pending.action.label, "View collection progress");
    assert.match(model.impact({ pending: 2 }, { enabled: false }).guidance, /Refresh can continue.*stays paused/);
    assert.match(model.impact({}, { unfinished: 1 }).guidance, /Copilot finishes saving/);
    assert.match(model.impact({ eligible: 2, unavailable: 2, limited: 0, pending: 0, groups: { missing: 2 } }).explanation, /couldn't read any/);
    for (const code of ["permission", "read", "unsupported", "unknown", "unrecognized-private-code"]) {
        const value = model.impact({ unavailable: 1, limited: 0, groups: { [code]: 1 } });
        assert.doesNotMatch(value.guidance, /won't fix|won't repair|automatically|path/);
        assert.doesNotMatch(JSON.stringify(value), /unrecognized-private-code/);
    }
    assert.match(model.impact({}).explanation, /couldn't confirm/);
    assert.equal(model.impact({}).action.label, "View collection details");
    assert.doesNotMatch(model.impact(actualShape, { unchecked: null }).guidance, /won't fix|automatically/);
    assert.doesNotMatch(model.impact({ unavailable: 0, limited: 3, pending: 0, groups: { context: 3, unknown: -1 } }).guidance, /won't fix|won't repair/);
});

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
        assert.ok(createLocalSearch().matches(model.reasonTitles[code], model.searchTerms(row)), code);
    }
    const mixed = { name: "Synthetic Beacon", reasons: ["missing", "truncated", "context"], unavailable: true };
    assert.ok(createLocalSearch().matches("unavailable", model.searchTerms(mixed)));
    assert.ok(!createLocalSearch().matches("limited", model.searchTerms(mixed)));
    const oversized = { name: "Synthetic Cedar", reasons: ["oversized"], unavailable: false };
    assert.ok(createLocalSearch().matches("limited", model.searchTerms(oversized)));
    assert.ok(!createLocalSearch().matches("unavailable", model.searchTerms(oversized)), "A negated explanation must not turn a limited chat into an unavailable search match.");
});

test("page health separates running collection from gaps and offers navigation rather than repair", () => {
    const active = { state: "collecting-on-interval", config: { approved: true, enabled: true }, discovery: {},
        lastCheckedAt: "2026-10-09T12:00:00Z", historyCoverage: { eligible: 10, readable: 8, unavailable: 2, limited: 3, affected: 5, pending: 0 } };
    assert.equal(model.page(active).label, "Collection active");
    assert.match(model.page(active).guidance, /activity may be missing.*useful next step/);
    assert.equal(model.page(active).action, undefined);
    const unreadable = model.page({ ...active, historyCoverage: { eligible: 10, unavailable: 10 } });
    assert.equal(unreadable.label, "Chat history couldn't be read");
    assert.equal(unreadable.severity, "error");
    assert.match(unreadable.guidance, /New activity.*cannot be collected/);
    assert.doesNotMatch(unreadable.guidance, /No action|healthy|repair/);
    assert.match(model.page({ ...active, state: "paused" }).action.href, /setting=collection-state$/);
    assert.match(model.page({ state: "disconnected" }).action.href, /setting=source$/);
    assert.equal(model.page({ ...active, state: "disconnected" }).label, "Collection disconnected");
    assert.equal(model.page({ ...active, state: "error" }).severity, "error");
    assert.equal(model.page({ ...active, state: "stopped" }).severity, "error");
    assert.match(model.page({ ...active, error: "PRIVATE_ERROR" }).guidance, /Previously collected evidence is kept/);
    assert.doesNotMatch(model.page({ ...active, error: "PRIVATE_ERROR" }).guidance, /PRIVATE_ERROR/);
    assert.match(model.page({ ...active, historyCoverage: { ...active.historyCoverage, pending: 1 } }).guidance, /Automatic checks will continue/);
    assert.doesNotMatch(model.page({ ...active, historyCoverage: { unavailable: 1, limited: 0 } }).guidance, /No action is needed/);
    assert.equal(model.page({ ...active, discovery: null }).label, "Checking history");
    assert.equal(model.page({ ...active, state: "collecting" }).label, "Checking history");
    assert.equal(model.page({ ...active, historyCoverage: { eligible: 0 } }).action.label, "Review source in Settings");
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
