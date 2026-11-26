import test from "node:test";
import assert from "node:assert/strict";
import { createFilterState } from "../../web/client.mjs";
import { createRecordedResults } from "../../web/recorded-results.mjs";
import { createPromptAuthorship } from "../../lib/prompt-authorship.mjs";
import { createSessionJourney } from "../../web/session-journey.mjs";

const filters = createFilterState(createRecordedResults(), createPromptAuthorship());

test("card and reader source identity requires consistent canonical row provenance", () => {
    for (const source of filters.sources) {
        assert.deepEqual(filters.sourceIdentity([{ sourceId: source.id }, { sourceId: source.id }]), source);
    }
    for (const rows of [[], [{}], [{ sourceId: "unknown-source" }],
        [{ sourceId: "github-copilot" }, { sourceId: "microsoft-365-chat" }],
        [{ sourceId: "github-copilot" }, {}]]) {
        assert.equal(filters.sourceIdentity(rows), null, "Unknown or mixed origin must not be guessed from the selected source.");
    }
});

test("bounded reader return preserves exact public origin without carrying detail selectors into Analyze", () => {
    const journey = createSessionJourney();
    const route = { view: "request", source: "microsoft-365-chat", request: "a".repeat(64), nativeGroup: "c".repeat(64),
        nativeSource: "microsoft-365-chat", nativeRevision: "5", nativeSourceRevision: "b".repeat(64), nativeOrdinal: "42" };
    const saved = journey.savedOrigin(route);
    for (const key of ["request", "nativeSource", "nativeRevision", "nativeSourceRevision", "nativeOrdinal"]) {
        assert.equal(saved[key], route[key]);
        assert.equal(saved.returnToResults[key], undefined);
    }
    assert.equal(saved.returnToResults.source, route.source);
    assert.equal(saved.returnToResults.nativeGroup, route.nativeGroup);
});

test("one source choice composes with existing filters and survives exact reader return", () => {
    const journey = createSessionJourney();
    assert.deepEqual(filters.sources, [
        { id: "github-copilot", label: "GitHub Copilot" },
        { id: "microsoft-365-chat", label: "Microsoft 365 Copilot Chat" },
        { id: "microsoft-365-cowork", label: "Cowork" },
    ]);
    for (const { id, label } of filters.sources) {
        const route = { view: "analyze", source: id, from: "2026-10-01", to: "2026-10-02",
            tool: "native.literal.tool", result: "unknown", services: "Files", includeMissingService: true };
        const expected = { scope: "history", includeMetadata: false, sources: [id],
            from: route.from, to: route.to, tools: [route.tool], outcomes: ["unknown"], services: ["Files"], includeMissingService: true };
        assert.deepEqual(filters.query(route), expected);
        assert.equal(filters.sourceLabel(id), label);
        assert.deepEqual(filters.query(journey.returnRoute(route)), expected);
        const scoped = filters.scope(route, journey.open(route, '["exact","native","conversation"]'));
        assert.deepEqual(filters.query(scoped), { ...expected, sourceSessionIds: ['["exact","native","conversation"]'] });
        const reader = { ...route, view: "request", request: '["exact","native","record"]', returnToResults: route };
        assert.equal(journey.savedOrigin(reader).request, reader.request);
        assert.deepEqual(journey.underlying(reader), route);
    }
    assert.equal(filters.canonical({ source: "all" }).source, undefined);
    assert.deepEqual(filters.query(filters.canonical({ source: "all" })), { scope: "history", includeMetadata: false });
    assert.deepEqual(filters.query({ source: "unknown-source" }).sources, ["unknown-source"], "Invalid intent must reach backend validation, not silently broaden.");
    assert.throws(() => filters.sourceLabel("unknown-source"), /source.*unavailable/i);
    assert.deepEqual(filters.query({ source: "microsoft-365", result: "failure" }), {
        scope: "history", includeMetadata: false, sources: ["microsoft-365-chat", "microsoft-365-cowork"], outcomes: ["failure"],
    });
    assert.equal(filters.sourceLabel("microsoft-365"), "Microsoft 365");
});

test("Analyze defaults to individual days without coarsening unbounded or long ranges", () => {
    for (const range of ["day", "week", "month", "7", "30"]) assert.equal(filters.bucket({ range }), "day");
    assert.equal(filters.bucket({}), "day");
    assert.equal(filters.bucket({ from: "2026-03-01" }), "day");
    assert.equal(filters.bucket({ to: "2026-03-31" }), "day");
    assert.equal(filters.bucket({ range: "custom", from: "2026-03-01", to: "2026-03-31" }), "day");
    assert.equal(filters.bucket({ range: "custom", from: "2026-01-01", to: "2026-10-01" }), "day");
    assert.equal(filters.bucket({ range: "custom", from: "2020-01-01", to: "2026-10-01" }), "day");
    for (const bucket of ["day", "week", "month"]) {
        assert.equal(filters.bucket({ bucket }), bucket);
        assert.equal(filters.bucket({ range: "custom", from: "2026-03-01", to: "2026-03-31", bucket }), bucket);
    }
    assert.deepEqual(filters.query({ range: "week", from: "2026-03-02", to: "2026-03-08" }),
        { scope: "history", includeMetadata: false, from: "2026-03-02", to: "2026-03-08" });
});

test("timeline retirement follows canonical population selectors rather than a second filter-field list", () => {
    const previous = { view: "analyze", services: "Mail", includeMissingService: true, bucket: "week", timelineFrom: "2016-11-16" };
    for (const change of [
        { includeMissingService: false }, { source: "microsoft-365-chat" }, { tool: "workiq-retrieve" },
        { service: "Files" }, { services: "Files" }, { result: "failure" }, { authors: "user" },
        { project: "project" }, { session: "chat" }, { endpoint: "path" }, { scope: "legacy" },
        { layer: "reported-api" }, { from: "2026-11-16", to: "2026-11-16" },
        { withinServices: "Mail" }, { nativeGroup: "native-group" }, { search: "literal" }, { analysisQuery: "literal" },
    ]) {
        const next = filters.reconcileTimeline(previous, { ...previous, ...change });
        assert.equal(next.timelineFrom, undefined, JSON.stringify(change));
        assert.deepEqual(filters.query(next), filters.query(filters.canonical({ ...previous, ...change })));
        assert.equal(next.bucket, "week");
    }
    for (const change of [{ page: "2" }, { chart: "endpoint" }, { view: "request", request: "call" },
        { range: "custom" }, { services: "Mail,Mail", includeMissingService: "true" }]) {
        assert.equal(filters.reconcileTimeline(previous, { ...previous, ...change }).timelineFrom, previous.timelineFrom);
    }
    const moved = filters.reconcileTimeline(previous, { ...previous, timelineFrom: "2026-11-16" });
    assert.equal(moved.timelineFrom, "2026-11-16");
    const interval = filters.reconcileTimeline(previous, { ...previous, bucket: "month" });
    assert.equal(interval.timelineFrom, undefined); assert.equal(interval.bucket, "month");
    const scoped = filters.scope(previous, { session: "another-chat" });
    assert.equal(scoped.timelineFrom, undefined);
    assert.equal(scoped.includeMissingService, true);
});

test("association routes stay distinct from legacy categories and preserve explicit strict scope", () => {
    assert.deepEqual(filters.query({ service: "Files" }), { scope: "history", includeMetadata: false, workloads: ["Files"] });
    assert.deepEqual(filters.query(filters.canonical({ services: "Mail,Files,Mail", includeMissingService: "false", tool: "workiq-fetch" })), {
        scope: "history", includeMetadata: false, tools: ["workiq-fetch"], services: ["Files", "Mail"], includeMissingService: false,
    });

    assert.deepEqual(filters.query({ services: "Files" }), { scope: "history", includeMetadata: false, services: ["Files"] });
    assert.equal(filters.query(filters.canonical({ services: "Files", includeMissingService: "true" })).includeMissingService, true);
    assert.equal(filters.canonical({ includeMissingService: "true" }).includeMissingService, undefined);
    assert.equal(filters.query(filters.canonical({ services: "Files", includeMissingService: "invalid" })).includeMissingService, "invalid",
        "Invalid explicit state reaches normal query validation; it never silently becomes strict or All.");
});

test("scoped chat navigation retains all analytical filters but not paging or private search", () => {
    const route = { view: "home", tool: "workiq-fetch", services: "Files", includeMissingService: false, service: "Multiple workloads",
        project: "invented-project", result: "failure,unknown", authors: "user,agent", layer: "tool", scope: "all",
        range: "custom", from: "2026-10-01", to: "2026-10-02", bucket: "day", endpoint: "invented-endpoint",
        page: "2", search: "private text", request: "old-request" };
    const scoped = filters.scope(route, { view: "activity", session: "invented-chat" });
    assert.equal(scoped.page, undefined);
    assert.equal(scoped.search, undefined);
    assert.equal(scoped.request, undefined);
    assert.equal(scoped.includeMissingService, false);
    assert.deepEqual(filters.query(scoped), { ...filters.query(route), sourceSessionIds: ["invented-chat"] });
    assert.equal(scoped.bucket, "day");
    assert.equal(filters.scope(route, { view: "activity", result: "success" }).result, "success", "Explicit result links override only their named field.");
});

test("service chart refinements canonicalize separately from server OR filters and survive scoped navigation", () => {
    const route = filters.canonical({ services: "Mail,Files", includeMissingService: true, withinServices: "Mail,Calendar,Mail" });
    assert.equal(route.withinServices, "Calendar,Mail");
    assert.deepEqual(filters.query(route), { scope: "history", includeMetadata: false, services: ["Files", "Mail"], includeMissingService: true });
    assert.equal(filters.scope(route, { view: "analyze", session: "invented" }).withinServices, "Calendar,Mail");
    assert.equal(filters.canonical({ withinServices: ",," }).withinServices, undefined);
});
