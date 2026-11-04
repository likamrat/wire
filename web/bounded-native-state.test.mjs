import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedNativeState } from "./bounded-native-state.mjs";

const reference = digit => digit.repeat(64);
const counters = () => ({ conversations: 0, variants: 0, messages: 0, parts: 0, taskStates: 0, calls: 0, returnedResults: 0 });
const outcomes = () => ({ success: 0, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 });
// Empty protocol metadata only, not an invented activity corpus.
const response = () => ({
    schemaVersion: 1, kind: "native-retained-page", revision: 1, sourceRevision: reference("a"), selectionRef: reference("b"),
    definitions: { toolUnit: "Native call identity" },
    readback: { schemaVersion: 1, snapshotRef: reference("c"), committed: null,
        current: { generation: 2, configurationRevision: 1, privacyRevision: 1 } },
    aggregates: { complete: true, layer: "tool", ...counters(), selectedRows: 0, outcomes: outcomes() },
    coverage: { history: "selected-retained-root-not-complete-source-history", activityDates: "unqualified",
        services: "unqualified", responseLatency: "unsupported", pageIsPopulation: false },
    grouping: { complete: true, groupBy: "workload", groupCount: 0, groups: [], other: null },
    resultFacet: { complete: true, scope: "before-outcome", count: 0, outcomes: outcomes() },
    timeSeries: { qualification: "unqualified", datedRows: 0, undatedRows: 0 },
    page: { items: [], limit: 10, nextCursor: null },
});
const request = () => ({ schemaVersion: 1, revision: 1, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
    analytics: { layer: "tool", groupBy: "workload", filters: {} }, page: { limit: 10, after: null } });

test("optional reader deletion authority is validated without inventing legacy authority", () => {
    const model = createBoundedNativeState(), value = response();
    assert.equal(Object.hasOwn(model.decode(value, request()).readback, "deletionVersion"), false);
    value.readback.deletionVersion = 0;
    assert.equal(model.decode(value, request()).readback.deletionVersion, 0);
    for (const invalid of [-1, 0.5, "0", null]) {
        assert.throws(() => model.decode({ ...value, readback: { ...value.readback, deletionVersion: invalid } }, request()), TypeError);
    }
});

test("shared validation failure is concise while source errors stay distinct", () => {
    const model = createBoundedNativeState();
    assert.throws(() => model.decode({ ...response(), unexpected: true }, request()), {
        name: "TypeError", message: "Saved Microsoft activity could not be verified.",
    });
    const ticket = model.begin(request(), {});
    model.fail(ticket, new Error("The source refused this particular record."));
    assert.equal(model.snapshot().error, "The source refused this particular record.");
});

test("optional card dates reject invented instants and inconsistent selected-row coverage", () => {
    const model = createBoundedNativeState(), value = response();
    value.aggregates.conversations = value.aggregates.variants = 1;
    value.page.items = [{ id: reference("1"), sourceId: "microsoft-365-chat", title: "Recorded context",
        counts: { ...counters(), conversations: 1, variants: 1 }, selectedRows: 0, outcomes: outcomes(),
        presentation: { kind: "context", tools: [], toolCount: 0,
            activityDateRange: { firstAt: null, lastAt: null, datedRows: 0, undatedRows: 0 } } }];
    assert.deepEqual(model.decode(value, request()), value);
    for (const change of [
        range => { range.firstAt = "2026-01-01T00:00:00Z"; },
        range => { range.datedRows = 1; },
        range => { range.undatedRows = 1; },
        range => { range.capturedAt = "2026-01-01T00:00:00Z"; },
    ]) {
        const invalid = structuredClone(value); change(invalid.page.items[0].presentation.activityDateRange);
        assert.throws(() => model.decode(invalid, request()), TypeError);
    }
});

test("bounded presentation extensions validate complete source/tool partitions and time counts", () => {
    const model = createBoundedNativeState(), value = response();
    value.toolGroups = { ...value.grouping, groupBy: "tool" };
    value.sourceGroups = [];
    value.timeSeries = { ...value.timeSeries, bucket: "day", timeZone: "UTC", points: [] };
    assert.deepEqual(model.decode(value, request()), value);
    assert.throws(() => model.decode({ ...value, sourceGroups: [{ sourceId: "github-copilot", conversations: 0, count: 0, outcomes: outcomes() }] }, request()), TypeError);
    assert.throws(() => model.decode({ ...value, timeSeries: { ...value.timeSeries, datedRows: 1 } }, request()), TypeError);
});

test("inventory validates original-root headers and unavailable null counts without query-shaped input", () => {
    const model = createBoundedNativeState(), original = response();
    const { aggregates, coverage, grouping, resultFacet, timeSeries, ...header } = original;
    const value = { ...header, kind: "native-retained-inventory", dimension: "tools", qualification: "available",
        aggregates: { complete: true, options: 0, unavailableRows: 0, selectedRows: 0 } };
    const input = { schemaVersion: 1, revision: 1, viewId: reference("f"), dimension: "tools", page: { limit: 10, after: null } };
    const context = { ...request(), original };
    assert.deepEqual(model.decode(value, input, context), value);
    assert.throws(() => model.decode({ ...value, sourceRevision: reference("f") }, input, context), TypeError);
    const unavailable = { ...value, dimension: "services", qualification: "unqualified", reason: "native-services-unqualified", aggregates: null };
    assert.deepEqual(model.decode(unavailable, { ...input, dimension: "services" }, context), unavailable);
    assert.throws(() => model.decode({ ...unavailable, aggregates: { complete: true, options: 0, unavailableRows: 0, selectedRows: 0 } },
        { ...input, dimension: "services" }, context), TypeError);
});

test("Analyze accepts only complete producer membership and keeps the original base on next pages", () => {
    const model = createBoundedNativeState(), original = response(), owner = {};
    const input = { schemaVersion: 1, revision: 1, viewId: reference("f"), query: "term", types: [],
        page: { limit: 10, after: null } };
    const value = { ...original, kind: "native-retained-analysis", viewId: reference("d"), allViewId: reference("e"),
        textSelection: { purpose: "analysis", matchPolicyId: reference("f"), coverage: "complete", layer: "tool",
            types: ["action", "context", "interaction", "reply"], membershipRef: reference("a"),
            reportScope: "complete-matched-conversations" }, page: { ...original.page, nextCursor: reference("d") } };
    const context = { ...request(), original };
    model.receive(model.begin(input, owner, context), value, owner);
    assert.equal(model.next().viewId, input.viewId);
    assert.equal(model.next().query, input.query);
    assert.throws(() => model.decode({ ...value, textSelection: { ...value.textSelection, coverage: "partial" } }, input, context), TypeError);
    assert.throws(() => model.decode({ ...value, query: "term" }, input, context), TypeError);
});

test("bounded query validates complete aggregates separately from its page", () => {
    const model = createBoundedNativeState(), value = response();
    assert.deepEqual(model.decode(value, request()), value);
    assert.throws(() => model.decode({ ...value, nativeConversation: {} }, request()), TypeError);
    assert.throws(() => model.decode({ ...value, aggregates: { ...value.aggregates, complete: false } }, request()), TypeError);
    assert.throws(() => model.decode({ ...value, timeSeries: { ...value.timeSeries, datedRows: 1 } }, request()), TypeError);
});

test("paging replaces one page, binds complete totals and retires late filter responses", () => {
    const model = createBoundedNativeState(), owner = {}, input = request(), value = response();
    const first = model.begin(input, owner);
    value.page.nextCursor = reference("d");
    model.receive(first, value, owner);
    assert.equal(model.snapshot().value.page.nextCursor, reference("d"));
    const secondInput = model.next();
    assert.equal(secondInput.page.after, reference("d"));
    assert.equal(secondInput.revision, 1);
    const second = model.begin(secondInput, owner);
    const changed = response(); changed.sourceRevision = reference("e");
    assert.throws(() => model.receive(second, changed, owner), /Saved Microsoft activity could not be verified/);
    assert.equal(model.snapshot().value, null);
    const newer = model.begin({ ...input, sources: ["microsoft-365-cowork"] }, owner);
    assert.equal(model.receive(first, value, owner), false);
    model.receive(newer, response(), owner);
    assert.equal(model.snapshot().value.page.items.length, 0);
    const pending = model.begin(input, owner);
    model.withdraw();
    assert.equal(model.receive(pending, value, owner), false);
});

test("byte-short pages retain exact offsets on back and retire cursor history after a root change", () => {
    const model = createBoundedNativeState(), owner = {}, input = request(), value = response();
    value.aggregates.conversations = value.aggregates.variants = 3;
    const item = id => ({ id: reference(id), sourceId: "microsoft-365-chat", title: "Recorded context",
        counts: { ...counters(), conversations: 1, variants: 1 }, selectedRows: 0, outcomes: outcomes() });
    const first = { ...value, page: { items: [item("1")], limit: 10, nextCursor: reference("d") } };
    const second = { ...value, page: { items: [item("2")], limit: 10, nextCursor: reference("e") } };
    model.receive(model.begin(input, owner), first, owner);
    model.receive(model.begin(model.next(), owner), second, owner);
    assert.equal(model.snapshot().pageOffset, 1);
    assert.equal(model.snapshot().pageCount, 1);
    model.receive(model.begin(model.previous(), owner, undefined, true), first, owner);
    assert.equal(model.snapshot().pageOffset, 0);
    model.receive(model.begin(model.next(), owner), second, owner);
    const ticket = model.begin(model.next(), owner);
    assert.throws(() => model.receive(ticket, { ...value, sourceRevision: reference("f") }, owner), TypeError);
    assert.deepEqual([model.snapshot().pageIndex, model.snapshot().pageOffset, model.snapshot().pageCount, model.snapshot().hasNext],
        [0, 0, 0, false]);
    assert.throws(() => model.previous(), TypeError);
});

test("detail and native Search stay distinct public pages without ordinary membership receipts", () => {
    const model = createBoundedNativeState(), value = response();
    for (const key of ["coverage", "grouping", "resultFacet", "timeSeries"]) delete value[key];
    value.kind = "native-retained-detail";
    value.conversationId = reference("d"); value.sourceId = "microsoft-365-chat";
    value.focusOrdinal = null; value.aggregates = { complete: true, variants: 0 };
    const input = { ...request(), conversationId: value.conversationId }; delete input.analytics;
    assert.deepEqual(model.decode(value, input), value);
    assert.throws(() => model.decode({ ...value, sourceId: "github-copilot" }, input), TypeError);
    const search = { ...value, kind: "native-retained-search", matchPolicyId: reference("e"),
        aggregates: { complete: true, matched: 0, scanned: 0, unavailableText: 0 },
        coverage: { history: "selected-retained-root-not-complete-source-history", actionUnit: "native-call-observation",
            fields: "authorized-messages-source-facts-and-call-inputs", pageIsPopulation: false } };
    delete search.conversationId; delete search.sourceId; delete search.focusOrdinal;
    const searchInput = { ...request(), query: "term", types: [] }; delete searchInput.analytics;
    assert.deepEqual(model.decode(search, searchInput), search);
    assert.throws(() => model.decode({ ...search, receipt: {} }, searchInput), TypeError);
});

test("bounded completion requires the qualified original operation and matching displayed public root tuple", () => {
    const model = createBoundedNativeState(), value = response(), operationId = "00000000-0000-4000-8000-000000000001";
    const committed = { operationId, revision: 1, generation: 2, configurationRevision: 1, privacyRevision: 1 };
    value.readback.committed = committed;
    const qualification = { schemaVersion: 1, kind: "native-operation-readback", operationId, status: "matched",
        revision: 1, sourceRevision: value.sourceRevision, readback: value.readback };
    const receipt = { ...committed, status: "committed" };
    assert.equal(model.matchesReadback(qualification, value, receipt), true);
    assert.equal(model.matchesReadback({ ...qualification, sourceRevision: reference("d") }, value, receipt), false);
    assert.equal(model.matchesReadback(qualification, value, { ...receipt, operationId: "00000000-0000-4000-8000-000000000002" }), false);
    assert.equal(model.matchesReadback({ schemaVersion: 1, kind: "native-operation-readback", operationId,
        status: "unconfirmed", reason: "committed-readback-mismatch" }, value, receipt), false);
    assert.throws(() => model.decodeReadback({ ...qualification, accountRef: "forbidden" }, operationId), TypeError);
    const savedAt = "2026-01-01T12:00:00.000Z";
    value.readback.committed = { ...committed, committedAt: savedAt };
    assert.equal(model.decode(value, request()).readback.committed.committedAt, savedAt);
    assert.equal(model.matchesReadback(qualification, value, { ...receipt, status: "unknown" }), false);
    for (const committedAt of [null, 1, "", "not-a-date"]) {
        assert.throws(() => model.decode({ ...value, readback: { ...value.readback,
            committed: { ...committed, committedAt } } }, request()), TypeError);
    }
});
