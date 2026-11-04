import test from "node:test";
import assert from "node:assert/strict";
import { committedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { chatFixture, coworkFixture, absent, envelope, recorded } from "./native-read-model-fixtures.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { currentStatePayload, executeAction } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { chatSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";

const input = () => ({ schemaVersion: 1, revision: null,
    sources: ["microsoft-365-chat", "microsoft-365-cowork"],
    analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 1, after: null } });

test("bounded activity carries screened prompt recognition and whole-selection tool counts", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const result = await views.query({ ...input(), page: { limit: 10, after: null } }, app.services.nativeReportAdmission);
    const chat = result.page.items.find(item => item.sourceId === "microsoft-365-chat");
    const cowork = result.page.items.find(item => item.sourceId === "microsoft-365-cowork");
    assert.equal(chat.title, "An invented question.");
    assert.equal(chat.presentation.kind, "prompt");
    assert.equal(cowork.title, "Read the invented records.");
    assert.equal(cowork.presentation.kind, "prompt");
    assert.deepEqual(cowork.presentation.tools, ["mcp__graph__CallGraph", "mcp__m365_search__SearchM365", "mcp__outlook__MoveMessage"]);
    assert.equal(cowork.presentation.toolCount, 3);
    assert.equal(result.toolGroups.groups.reduce((sum, group) => sum + group.count, 0), 3);
    assert.deepEqual(result.sourceGroups.map(group => [group.sourceId, group.conversations, group.count]),
        [["microsoft-365-chat", 1, 0], ["microsoft-365-cowork", 1, 3]]);
    const inventory = await views.inventory({ schemaVersion: 1, revision: result.revision, viewId: result.viewId,
        dimension: "conversations", page: { limit: 10, after: null } }, app.services.nativeReportAdmission);
    assert.ok(inventory.page.items.some(item => item.label.includes("Read the invented records.")));
});

test("bounded time charts use current call-start facts, retain undated calls and match date drilldown", async t => {
    const rows = coworkFixture();
    for (const row of rows.filter(row => ["ts", "tx"].includes(row.record.event))) {
        const value = row.record.event === "ts" ? "2026-01-02T07:30:00.000Z" : "2026-01-03T07:30:00.000Z";
        row.record.data.ts = value;
        row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
            unit: "iso8601", basis: "cowork.data.ts", value };
        row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
            pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
    }
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: rows });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const analytics = { layer: "tool", bucket: "day", filters: { scope: "all" }, timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" } };
    const result = await views.query({ ...input(), analytics }, app.services.nativeReportAdmission);
    assert.equal(result.timeSeries.qualification, "source-observation-qualified");
    assert.equal(result.timeSeries.datedRows, 2);
    assert.equal(result.timeSeries.undatedRows, 1, "Completion-only observations are not call starts.");
    assert.deepEqual(result.page.items[0].presentation.activityDateRange, {
        firstAt: "2026-01-02T07:30:00.000Z", lastAt: "2026-01-02T07:30:00.000Z", datedRows: 2, undatedRows: 1,
    });
    assert.equal(result.timeSeries.points[0].date, "2026-01-01");
    assert.equal(result.timeSeries.points[0].count, 2);
    const point = result.timeSeries.points[0];
    const dated = await views.query({ ...input(), analytics: { ...analytics, filters: { ...analytics.filters, from: point.from, to: point.to } } },
        app.services.nativeReportAdmission);
    assert.equal(dated.aggregates.selectedRows, point.count);
    assert.deepEqual(dated.aggregates.outcomes, point.outcomes);
    const tool = await views.query({ ...input(), analytics: { ...analytics,
        filters: { from: point.from, to: point.to, tools: ["mcp__graph__CallGraph"] } } }, app.services.nativeReportAdmission);
    assert.equal(tool.aggregates.selectedRows, 1, "Call-specific filters still apply to actual dated call rows.");
});

test("bounded Dates retain ordinary Chat message context without inventing dated calls", async t => {
    const [row] = retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource({
        messageId: "invented-dated-message", author: "user", messageType: "Chat", text: "An existing dated question.",
    })));
    row.record.createdAt = "2026-01-02T12:00:00Z";
    row.qualifiedFields.messageCreatedAt = { scope: "message", availability: "recorded", value: row.record.createdAt };
    row.evidenceReferences.messageCreatedAt = { sourceDocument: row.chatSource.source.sourceDocument,
        pointer: `${row.chatSource.source.pointer}/createdAt`, nativeEventId: row.record.messageId };
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [row] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const result = await views.query({ ...input(), analytics: { filters: { from: "2026-01-02", to: "2026-01-02" } } },
        app.services.nativeReportAdmission);
    assert.equal(result.aggregates.conversations, 1);
    assert.equal(result.aggregates.calls, 0);
    assert.equal(result.timeSeries.datedRows, 0);
    assert.equal(result.page.items[0].presentation.kind, "prompt");
    assert.equal(result.page.items[0].presentation.contextDateBasis, "ordinary-message-created");
    for (const [name, filter] of [["service", { services: ["Mail"] }], ["endpoint", { endpoints: ["/me/messages"] }]]) {
        await t.test(`dated context does not enter ${name} call predicates`, async () => {
            const selected = await views.query({ ...input(), analytics: {
                filters: { from: "2026-01-02", to: "2026-01-02", ...filter },
            } }, app.services.nativeReportAdmission);
            assert.equal(selected.aggregates.conversations, 0);
            assert.equal(selected.aggregates.selectedRows, 0);
        });
    }
});

test("multipart conversation context supplies recognition without claiming a prompt or call", async t => {
    const part = envelope("cowork", { id: "invented-part-event", event: "rc", data: {} });
    part.messageParts = [{ message: recorded({ author: "unknown", representation: "reply-fragment", text: "Recorded multipart fragment." }),
        evidence: { sourceDocument: "invented-parts", pointer: "/data/content/0", nativeEventId: "invented-part-event" } }];
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [part] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const value = await views.query(input(), app.services.nativeReportAdmission);
    assert.equal(value.page.items[0].title, "Recorded multipart fragment.");
    assert.equal(value.page.items[0].presentation.kind, "context");
    assert.equal(value.aggregates.calls, 0);
    assert.equal(value.aggregates.parts, 1);
});

test("bounded retained query reports complete native units separately from public conversation pages", async t => {
    const app = await committedNativeReportFixture(t), views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const result = await views.query(input(), app.services.nativeReportAdmission);
    const expected = buildActivityAnalytics(app.services.nativeRecords, input().analytics);
    assert.equal(result.kind, "native-retained-page");
    assert.equal(result.aggregates.complete, true);
    assert.equal(result.aggregates.calls, expected.totals.count);
    assert.equal(result.aggregates.conversations, app.services.nativeRecords.length);
    assert.equal(result.grouping.complete, true);
    assert.deepEqual(result.grouping.groups.map(group => [group.label, group.count]),
        expected.visibleGroups.map(group => [group.label, group.total]));
    assert.equal(result.resultFacet.count, expected.resultFacet.totals.count);
    assert.equal(result.page.items.length, 1);
    assert.match(result.page.items[0].id, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /rootHash|tenantId|subjectId|nativeSourceBinding|nativeConversation/);
});

for (const segmented of [false, true]) test(`v${segmented ? 2 : 1} bounded pages and Search bind the entire authorized root without exposing private identities`, async t => {
    const app = await committedNativeReportFixture(t, { segmented, envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const request = app.services.nativeReportAdmission, first = await views.query(input(), request);
    const second = await views.query({ ...input(), revision: first.revision,
        page: { limit: 1, after: first.page.nextCursor } }, request);
    assert.equal(first.aggregates.conversations, 2);
    assert.deepEqual(second.aggregates, first.aggregates);
    assert.notEqual(first.page.items[0].id, second.page.items[0].id);
    assert.equal(second.page.nextCursor, null);
    for (const layer of ["tool", "reported-api"]) {
        const analytics = { layer, groupBy: "tool", limit: 1, filters: { outcomes: ["success"] } };
        const expected = buildActivityAnalytics(app.services.nativeRecords, analytics);
        const filtered = await views.query({ ...input(), analytics }, request);
        assert.equal(filtered.aggregates.selectedRows, expected.totals.count);
        assert.equal(filtered.resultFacet.count, expected.resultFacet.totals.count);
        assert.deepEqual(filtered.grouping.groups.map(group => [group.label, group.count]),
            expected.visibleGroups.map(group => [group.label, group.total]));
        assert.equal(filtered.grouping.other?.count ?? 0, expected.otherGroup?.total ?? 0);
    }
    await assert.rejects(views.query({ ...input(), page: { limit: 1, after: first.page.nextCursor } },
        { ...request, owner: "another-native-view-owner" }), { code: "NATIVE_VIEW_CURSOR_STALE" });
    const detail = await views.detail({ schemaVersion: 1, revision: first.revision, sources: input().sources,
        conversationId: first.page.items[0].id, page: { limit: 1, after: null } }, request);
    assert.equal(detail.page.items.length, 1);
    assert.equal(detail.aggregates.variants, first.page.items[0].counts.variants);
    assert.ok(detail.page.nextCursor);
    const search = await views.search({ schemaVersion: 1, revision: first.revision, sources: input().sources,
        query: "Read", types: [], page: { limit: 1, after: null } }, request);
    assert.equal(search.aggregates.complete, true);
    assert.ok(search.aggregates.matched > 0);
    assert.equal(search.page.items.length, 1);
    const hitIds = new Set(search.page.items.map(hit => hit.id));
    let cursor = search.page.nextCursor;
    while (cursor) {
        const next = await views.search({ schemaVersion: 1, revision: first.revision, sources: input().sources,
            query: "Read", types: [], page: { limit: 1, after: cursor } }, request);
        assert.deepEqual(next.aggregates, search.aggregates);
        for (const hit of next.page.items) {
            assert.equal(hitIds.has(hit.id), false);
            hitIds.add(hit.id);
        }
        cursor = next.page.nextCursor;
    }
    assert.equal(hitIds.size, search.aggregates.matched);
    const privateValues = await app.persistence.withRetainedReader({ revision: first.revision }, request,
        reader => ({ root: reader.rootHash, account: reader.account.partition }));
    for (const response of [first, second, detail, search]) {
        const text = JSON.stringify(response);
        assert.doesNotMatch(text, /rootHash|tenantId|subjectId|nativeSourceBinding|pseudonymKey/);
        assert.equal(text.includes(privateValues.root), false);
        assert.equal(text.includes(privateValues.account), false);
    }
    const dated = await views.query({ ...input(), analytics: { filters: { from: "2026-01-01", to: "2026-12-31" } } }, request);
    assert.equal(dated.aggregates.conversations, 0);
    assert.equal(dated.aggregates.calls, 0);
    const before = await loadBoardState(app.context);
    assert.equal(before.revision, first.revision, "Queries cannot mutate or adopt the retained root.");
    await updateBoardState(app.context, state => { state.continuation = "Existing fixture state changed."; });
    await assert.rejects(views.detail({ schemaVersion: 1, revision: null, sources: input().sources,
        conversationId: detail.conversationId, page: { limit: 1, after: detail.page.nextCursor } }, request),
    { code: "NATIVE_VIEW_CURSOR_STALE" });
});

test("bounded runtime requests reject copied guards and do not outlive the response owner", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const access = await createNativeRuntimeAccess(app.context, { lifecycle: app.lifecycle, nativePersistence: app.persistence,
        acquireNative() { assert.fail("Read cannot acquire source."); } });
    t.after(() => access.close());
    const guard = await access.read("native-bounded-response-owner");
    const admission = { check() {} };
    assert.throws(() => access.nativeRetainedFor({ ...guard }, admission), { code: "wire_access_invalid_lease" });
    const view = access.nativeRetainedFor(guard, admission);
    assert.equal((await view.query(input())).aggregates.complete, true);
    guard.release();
    await assert.rejects(view.query(input()), { code: "wire_access_revoked" });
});

test("segmented operation readback resolves only the genuine original panel receipt", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const access = await createNativeRuntimeAccess(app.context, { lifecycle: app.lifecycle, nativePersistence: app.persistence,
        acquireNative() { assert.fail("Readback cannot acquire source."); } });
    t.after(() => access.close());
    const guard = await access.read(app.owner);
    t.after(() => guard.release());
    const receipt = (await loadBoardState(app.context)).nativeRetention.receipts.at(-1);
    const view = access.nativeRetainedFor(guard, { check() {} });
    const result = await view.readback({ schemaVersion: 1, operationId: receipt.operationId });
    assert.equal(result.status, "matched");
    assert.equal(result.readback.committed.revision, receipt.revision);
    assert.equal(JSON.stringify(result).includes(receipt.snapshot), false);
    assert.equal(JSON.stringify(result).includes(receipt.partition), false);
});

test("source-aware snapshot and analytics separate complete native aggregates from GitHub rows", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const access = await createNativeRuntimeAccess(app.context, { lifecycle: app.lifecycle, nativePersistence: app.persistence,
        acquireNative() { assert.fail("Read cannot acquire source."); } });
    t.after(() => access.close());
    const guard = await access.read("native-bounded-snapshot-owner");
    t.after(() => guard.release());
    const services = { sourceAware: true,
        ...access.nativeReportsFor(guard, { check() {}, dispatched() { assert.fail("Read cannot write."); } }),
        nativeRetained: access.nativeRetainedFor(guard, { check() {} }),
        nativePersistenceStatus: value => access.nativePersistenceStatus(value, { owner: guard.owner, check() {} }),
        nativeReader: { scan() { assert.fail("Source-aware consumers cannot rebuild a full historical array."); } },
    };
    const snapshot = await currentStatePayload(app.context, undefined, input().analytics, services.nativeReader, services);
    assert.equal(snapshot.nativeRead.status, "bounded");
    assert.equal(snapshot.nativeRead.aggregates.complete, true);
    assert.deepEqual(snapshot.analytics.native, snapshot.nativeRead);
    assert.equal(snapshot.scenarios.some(row => row.recordKind === "native-conversation"), false);
    const analytics = await executeAction(app.context, createExportController(app.context), guard.owner, "get_analytics",
        input().analytics, services);
    assert.deepEqual(analytics.native.aggregates, snapshot.nativeRead.aggregates);
});

test("bounded reader joins a call start to its original complete call outcome without pooling observations", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const query = await views.query(input(), app.services.nativeReportAdmission);
    const detail = await views.detail({ schemaVersion: 1, revision: query.revision, sources: input().sources,
        conversationId: query.page.items[0].id, page: { limit: 10, after: null } }, app.services.nativeReportAdmission);
    const start = detail.page.items.find(item => item.fields.input?.availability === "recorded");
    assert.deepEqual(start.callSummaries.map(call => [call.tool, call.outcome]), [["mcp__graph__CallGraph", "success"]]);
    assert.match(start.callSummaries[0].id, /^[a-f0-9]{64}$/);
    assert.equal(query.aggregates.calls, 3);
});

test("native Search Open seeks an exact admitted ordinal without loading earlier detail pages", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const request = app.services.nativeReportAdmission;
    const search = await views.search({ schemaVersion: 1, revision: null, sources: input().sources,
        query: "a", types: [], page: { limit: 100, after: null } }, request);
    const hit = search.page.items.find(item => item.target.ordinal > 0);
    assert.ok(hit);
    const seek = { schemaVersion: 1, revision: search.revision, sourceRevision: search.sourceRevision,
        sources: input().sources, conversationId: hit.target.conversationId, at: hit.target.ordinal,
        page: { limit: 1, after: null } };
    const opened = await views.detail(seek, request);
    assert.equal(opened.focusOrdinal, hit.target.ordinal);
    assert.equal(opened.page.items[0].ordinal, hit.target.ordinal);
    assert.equal(opened.sourceRevision, search.sourceRevision);
    if (opened.page.nextCursor) {
        const next = await views.detail({ schemaVersion: 1, revision: search.revision,
            sources: seek.sources, conversationId: seek.conversationId, page: { limit: 1, after: opened.page.nextCursor } }, request);
        assert.ok(next.page.items[0].ordinal > hit.target.ordinal);
    }
    await assert.rejects(views.detail({ ...seek, revision: null }, request), { code: "NATIVE_VIEW_INPUT_INVALID" });
    await assert.rejects(views.detail({ ...seek, sourceRevision: "0".repeat(64) }, request), { code: "NATIVE_VIEW_CURSOR_STALE" });
    const another = search.page.items.find(item => item.target.conversationId !== seek.conversationId);
    assert.ok(another);
    await assert.rejects(views.detail({ ...seek, at: another.target.ordinal }, request), { code: "NATIVE_VIEW_CONVERSATION_UNAVAILABLE" });
});

test("accepted native view membership resolves the complete selector rather than its visible page", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const request = app.services.nativeReportAdmission, page = await views.query(input(), request);
    assert.equal(page.page.items.length, 1);
    const selected = await views.resolveSelection({ schemaVersion: 1, viewId: page.viewId, kind: "current",
        revision: page.revision, nativeIds: [] }, request);
    assert.equal(selected.frame.originalViewExpectations.length, 2);
    assert.deepEqual(selected.frame.originalViewExpectations.map(item => item.scenarioId).toSorted(),
        app.services.nativeRecords.map(record => record.scenarioId).toSorted());
    assert.equal(selected.sourceRevision, page.sourceRevision);
    await assert.rejects(views.resolveSelection({ schemaVersion: 1, viewId: page.allViewId, kind: "all",
        revision: page.revision, nativeIds: [] },
        { ...request, owner: "other-native-selection-owner" }), { code: "NATIVE_VIEW_SELECTION_STALE" });
    const empty = await views.query({ ...input(), analytics: { filters: { from: "2026-01-01", to: "2026-12-31" } } }, request);
    const emptySelection = await views.resolveSelection({ schemaVersion: 1, viewId: empty.viewId, kind: "current",
        revision: empty.revision, nativeIds: [] }, request);
    assert.deepEqual(emptySelection.frame.originalViewExpectations, []);
    assert.equal(emptySelection.frame.source.sourceRevisionRef, empty.sourceRevision);
    assert.equal((await views.resolveSelection({ schemaVersion: 1, viewId: empty.viewId, kind: "selected",
        revision: empty.revision, nativeIds: [] }, request)).frame, null);
    await assert.rejects(views.resolveSelection({ schemaVersion: 1, viewId: empty.viewId, kind: "all",
        revision: empty.revision, nativeIds: [] }, request), { code: "NATIVE_VIEW_SELECTION_STALE" });
    assert.equal((await views.resolveSelection({ schemaVersion: 1, viewId: empty.allViewId, kind: "all",
        revision: empty.revision, nativeIds: [] }, request)).frame.originalViewExpectations.length, 2);
    await updateBoardState(app.context, state => { state.continuation = "Changed accepted view."; });
    await assert.rejects(views.resolveSelection({ schemaVersion: 1, viewId: page.viewId, kind: "current",
        revision: page.revision, nativeIds: [] }, request),
        { code: "NATIVE_REPORT_SOURCE_STALE" });
});

test("runtime report resolver preserves original accepted view across requests without sharing another owner's receipt", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true });
    const access = await createNativeRuntimeAccess(app.context, { lifecycle: app.lifecycle, nativePersistence: app.persistence,
        acquireNative() { assert.fail("Report view cannot acquire source."); } });
    t.after(() => access.close());
    const original = await access.read("accepted-native-report-owner");
    const page = await access.nativeRetainedFor(original, { check() {} }).query(input());
    original.release();
    const guard = await access.read("accepted-native-report-owner"), foreign = await access.read("foreign-native-report-owner");
    t.after(() => { guard.release(); foreign.release(); });
    const binding = { viewId: page.viewId, nativeIds: [page.page.items[0].id] };
    const resolver = access.nativeReportViewFor(guard, { check() {} }, binding);
    binding.nativeIds.push("0".repeat(64));
    const result = await resolver({ kind: "selected", revision: page.revision });
    assert.equal(result.sourceRevision, page.sourceRevision);
    assert.deepEqual(result.definitions, page.definitions);
    assert.equal(result.frame.originalViewExpectations.length, 1);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result).sort(), ["definitions", "frame", "kind", "revision", "sourceRevision"]);
    await assert.rejects(access.nativeReportViewFor(foreign, { check() {} }, { viewId: page.viewId, nativeIds: [] })({
        kind: "current", revision: page.revision,
    }), { code: "NATIVE_VIEW_SELECTION_STALE" });
    await assert.rejects(access.nativeReportViewFor(guard, { check() {} }, { viewId: page.viewId, nativeIds: ["0".repeat(64)] })({
        kind: "selected", revision: page.revision,
    }), { code: "NATIVE_VIEW_SELECTION_STALE" });
    guard.release();
    await assert.rejects(resolver({ kind: "selected", revision: page.revision }), { code: "wire_access_revoked" });
});

test("native tool inventories and group drilldown use the complete original root, not one card page", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const request = app.services.nativeReportAdmission;
    const page = await views.query({ ...input(), analytics: { layer: "tool", groupBy: "tool", limit: 1 } }, request);
    const inventory = await views.inventory({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
        dimension: "tools", page: { limit: 1, after: null } }, request);
    const expected = buildActivityAnalytics(app.services.nativeRecords, { layer: "tool", groupBy: "tool" });
    assert.equal(inventory.qualification, "available");
    assert.equal(inventory.aggregates.options, expected.groups.filter(group => group.label !== "Tool name not qualified").length);
    assert.equal(inventory.page.items.length, 1);
    const values = new Set(inventory.page.items.map(item => item.value));
    let after = inventory.page.nextCursor;
    while (after) {
        const next = await views.inventory({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
            dimension: "tools", page: { limit: 1, after } }, request);
        assert.deepEqual(next.aggregates, inventory.aggregates);
        for (const item of next.page.items) { assert.equal(values.has(item.value), false); values.add(item.value); }
        after = next.page.nextCursor;
    }
    assert.equal(values.size, inventory.aggregates.options);
    const group = page.grouping.groups[0];
    const drilldown = await views.drilldown({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
        groupId: group.id, page: { limit: 1, after: null } }, request);
    assert.equal(drilldown.aggregates.selectedRows, group.count);
    assert.ok(drilldown.page.items.every(item => item.selectedRows > 0));
    assert.equal(drilldown.kind, "native-retained-drilldown");
    const report = await views.resolveSelection({ schemaVersion: 1, revision: page.revision,
        viewId: drilldown.viewId, kind: "current", nativeIds: [] }, request);
    assert.equal(report.frame.originalViewExpectations.length, drilldown.aggregates.conversations);
    await assert.rejects(views.drilldown({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
        groupId: "0".repeat(64), page: { limit: 1, after: null } }, request), { code: "NATIVE_VIEW_GROUP_UNAVAILABLE" });
    const services = await views.inventory({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
        dimension: "services", page: { limit: 1, after: null } }, request);
    assert.equal(services.qualification, "unqualified");
    assert.deepEqual(services.page.items, []);
    assert.equal(services.aggregates, null);
    await assert.rejects(views.inventory({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
        dimension: "tools", page: { limit: 1, after: null } }, { ...request, owner: "foreign-filter-owner" }),
    { code: "NATIVE_VIEW_SELECTION_STALE" });
    await updateBoardState(app.context, state => { state.continuation = "Changed inventory source."; });
    await assert.rejects(views.drilldown({ schemaVersion: 1, revision: page.revision, viewId: page.viewId,
        groupId: group.id, page: { limit: 1, after: null } }, request), { code: "NATIVE_REPORT_SOURCE_STALE" });
});

for (const segmented of [false, true]) test(`v${segmented ? 2 : 1} Analyze text receipts distinguish whole conversation and exact call membership`, async t => {
    const app = await committedNativeReportFixture(t, { segmented, envelopes: [...chatFixture(), ...coworkFixture()] });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const request = app.services.nativeReportAdmission;
    const base = await views.query({ ...input(), analytics: { layer: "tool", groupBy: "tool" } }, request);
    const analyze = (query, types, view = base) => views.analyze({
        schemaVersion: 1, revision: view.revision, viewId: view.viewId, query, types, page: { limit: 1, after: null },
    }, request);
    const action = await analyze("CallGraph", ["action"]);
    assert.equal(action.kind, "native-retained-analysis");
    assert.equal(action.aggregates.calls, 1);
    assert.equal(action.aggregates.conversations, 1);
    assert.equal(action.textSelection.coverage, "complete");
    assert.match(action.textSelection.membershipRef, /^[a-f0-9]{64}$/);
    const group = action.grouping.groups[0];
    const drilldown = await views.drilldown({ schemaVersion: 1, revision: action.revision, viewId: action.viewId,
        groupId: group.id, page: { limit: 1, after: null } }, request);
    assert.equal(drilldown.aggregates.calls, 1);
    const inventory = await views.inventory({ schemaVersion: 1, revision: action.revision, viewId: action.viewId,
        dimension: "tools", page: { limit: 100, after: null } }, request);
    assert.deepEqual(inventory.page.items.map(item => item.value), ["mcp__graph__CallGraph"]);
    const reportScope = scope => views.resolveSelection({ schemaVersion: 1, revision: scope.revision, viewId: action.viewId,
        kind: scope.kind, nativeIds: [] }, request);
    const report = await createExportController(app.context).preview(app.owner, undefined,
        { formats: ["json"], promptMode: "none" }, { kind: "current", revision: action.revision, scenarioIds: [] }, undefined, {
            nativeReportSource: app.services.nativeReportSource, nativeReportAdmission: request,
            resolveNativeReportView: reportScope,
        });
    assert.equal(report.snapshot.nativeEvidence.conversations.length, 1);
    assert.equal(report.snapshot.nativeEvidence.conversations[0].calls.length, 3);
    assert.equal(report.snapshot.selectionScope.kind, "current");
    assert.equal(action.textSelection.reportScope, "complete-matched-conversations");
    const message = await analyze("Read the invented records", ["interaction"]);
    assert.equal(message.aggregates.calls, 3);
    assert.equal(message.aggregates.conversations, 1);
    const selected = await views.resolveSelection({ schemaVersion: 1, revision: message.revision, viewId: message.viewId,
        kind: "current", nativeIds: [] }, request);
    assert.equal(selected.frame.originalViewExpectations.length, 1);
    const broad = await analyze("invented", ["interaction"]);
    assert.equal(broad.aggregates.conversations, 2);
    assert.ok(broad.page.nextCursor);
    const next = await views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "invented", types: ["interaction"], page: { limit: 1, after: broad.page.nextCursor } }, request);
    assert.deepEqual(next.aggregates, broad.aggregates);
    assert.equal(next.textSelection.membershipRef, broad.textSelection.membershipRef);
    assert.notEqual(next.page.items[0].id, broad.page.items[0].id);
    const dated = await views.query({ ...input(), analytics: { filters: { from: "2026-01-01", to: "2026-12-31" } } }, request);
    assert.equal((await analyze("Read", ["interaction"], dated)).aggregates.conversations, 0);
    const failed = await views.query({ ...input(), analytics: { filters: { outcomes: ["failure"] } } }, request);
    assert.equal((await analyze("CallGraph", ["action"], failed)).aggregates.calls, 0);
    await assert.rejects(analyze("Read", ["interaction"], action), { code: "NATIVE_VIEW_ANALYSIS_BASE_REQUIRED" });
    await assert.rejects(views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "Read", types: ["interaction"], page: { limit: 1, after: null } },
    { ...request, owner: "foreign-analysis-request-owner" }), { code: "NATIVE_VIEW_SELECTION_STALE" });
    await updateBoardState(app.context, state => { state.continuation = "Changed Analyze root."; });
    await assert.rejects(analyze("CallGraph", ["action"]), { code: "NATIVE_REPORT_SOURCE_STALE" });
});

test("Analyze text refuses incomplete eligible text coverage instead of accepting partial membership", async t => {
    const envelopes = chatFixture();
    envelopes[0].qualifiedFields.message = absent("field-absent-from-read-response");
    const app = await committedNativeReportFixture(t, { envelopes });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const request = app.services.nativeReportAdmission, base = await views.query(input(), request);
    await assert.rejects(views.analyze({ schemaVersion: 1, revision: base.revision, viewId: base.viewId,
        query: "invented", types: [], page: { limit: 1, after: null } }, request), {
        code: "NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE", status: 428,
        message: "Some saved Microsoft text is unavailable. Search cannot verify all matching activity.",
    });
});
