import test from "node:test";
import assert from "node:assert/strict";
import { committedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";
import { coworkFixture, chatFixture, multiCallChatFixture, envelope, recorded } from "./native-read-model-fixtures.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { randomUUID } from "node:crypto";
import { adaptCoworkSourceRecordsWithResultFacts, COWORK_MATCHED_RESULT_ADAPTER_VERSION,
    adaptMatchedCoworkSourceRecords, COWORK_MATCHED_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";
import { coworkSourceContext, sourceObservation } from "./cowork-source-adapter-fixtures.mjs";
import { projectNativeReportCopies } from "../lib/native-report-copies.mjs";

async function reader(t, envelopes, segmented = true) {
    const app = await committedNativeReportFixture(t, { envelopes, segmented });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const sources = [...new Set(envelopes.map(row => "microsoft-365-" + row.scope.surface))];
    const page = await views.query({ schemaVersion: 1, revision: null, sources,
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } }, app.services.nativeReportAdmission);
    const input = { schemaVersion: 1, revision: page.revision, sources,
        conversationId: page.page.items[0].id, page: { limit: 10, after: null } };
    async function detail(section, changes = {}) {
        const request = { ...input, section, ...changes };
        const value = await views.detail(request, app.services.nativeReportAdmission);
        createBoundedNativeState().decode(value, request);
        return value;
    }
    return { app, views, page, input, detail };
}

test("native Cowork diagnostic survives the segmented writer and canonical call readback", async t => {
    const message = "Request blocked: the folder is read-only.";
    const context = coworkSourceContext();
    context.capture.parserVersion = COWORK_MATCHED_RESULT_ADAPTER_VERSION;
    const envelopes = adaptCoworkSourceRecordsWithResultFacts([
        sourceObservation({ id: "diagnostic-start", event: "ts",
            data: { tid: "diagnostic-call", tn: "native_document_update", inp: {} } }),
        sourceObservation({ id: "diagnostic-completion", event: "tx",
            data: { tid: "diagnostic-call", tn: "native_document_update", ok: false, err: message } }, 1),
    ], context);
    const r = await reader(t, envelopes);
    const value = await r.detail("calls");
    const call = value.page.items[0];
    assert.equal(call.callSummaries[0].outcome, "failure");
    const failure = call.evidenceFacts.find(fact => fact.fields.failure)?.fields.failure;
    assert.equal(failure?.value.diagnostic?.message, message,
        "A safe original native error must remain actionable after durable retention, not become generic text-excluded metadata.");
    assert.deepEqual(failure.evidence, [{ sourceDocument: "invented-response",
        pointer: "/messages/1/data/err", nativeEventId: "diagnostic-completion" }]);
});

test("native result readback keeps older exclusions and newer diagnostics as separate immutable variants", async t => {
    const raw = [sourceObservation({ id: "original-completion", event: "tx",
        data: { tid: "original-call", tn: "native_document_update", ok: false, err: "A recorded read-only failure." } })];
    const context = coworkSourceContext();
    const earlier = adaptMatchedCoworkSourceRecords(raw, { ...context,
        capture: { ...context.capture, parserVersion: COWORK_MATCHED_ADAPTER_VERSION } });
    const original = JSON.stringify(earlier);
    const later = adaptCoworkSourceRecordsWithResultFacts(raw, { ...context,
        capture: { ...context.capture, captureId: "later-source-capture", parserVersion: COWORK_MATCHED_RESULT_ADAPTER_VERSION } });
    const r = await reader(t, [...earlier, ...later]);
    const call = (await r.detail("calls")).page.items[0];
    assert.equal(call.evidenceFacts.length, 2);
    const old = call.evidenceFacts.find(row => row.retention.current === false).fields.failure.value;
    const current = call.evidenceFacts.find(row => row.retention.current === true).fields.failure.value;
    assert.equal(old.messageStatus, "text-excluded");
    assert.equal(old.diagnostic, undefined);
    assert.equal(current.diagnostic.message, "A recorded read-only failure.");
    assert.equal(JSON.stringify(earlier), original);
    assert.equal(call.callSummaries[0].outcome, "failure");
});

for (const segmented of [false, true]) test(`native description and null body survive v${segmented ? 2 : 1} retention without API outcomes`, async t => {
    const context = coworkSourceContext();
    context.capture.parserVersion = COWORK_MATCHED_RESULT_ADAPTER_VERSION;
    const envelopes = adaptCoworkSourceRecordsWithResultFacts([
        sourceObservation({ id: "successful-completion", event: "tx",
            data: { tid: "successful-call", tn: "native_document_fetch", ok: true, out: null,
                d: "Retrieved the selected item." } }),
    ], context);
    const r = await reader(t, envelopes, segmented);
    const call = (await r.detail("calls")).page.items[0], fact = call.evidenceFacts[0];
    assert.equal(call.callSummaries[0].outcome, "success");
    assert.equal(fact.fields.resultEvidence.value.description.text, "Retrieved the selected item.");
    assert.equal(fact.fields.resultEvidence.value.contentStatus, "explicit-null");
    assert.equal(fact.fields.resultEvidence.value.statusCode, null);
    assert.equal(fact.fields.resultEvidence.value.applicationError, null);
    assert.equal(fact.fields.resultEvidence.value.resultCount, null);
    assert.equal(fact.outcomes.nestedApi, undefined);
    assert.deepEqual(fact.fields.resultEvidence.evidence.map(ref => ref.pointer), ["/messages/0/data/out", "/messages/0/data/d"]);
    assert.deepEqual(projectNativeReportCopies(r.app.services.nativeRecords, "a".repeat(64),
        { promptMode: "original", recordedContext: true }).copies, [],
    "New reader descriptions cannot silently broaden the existing report text/disclosure contract.");
});

test("reader context retains task updates alongside authored messages", async t => {
    const r = await reader(t, coworkFixture());
    const messages = await r.detail("messages"), context = await r.detail("context");
    assert.ok(messages.page.items.some(item => item.fields.message.value.text === "Read the invented records."));
    assert.ok(context.page.items.some(item => item.outcomes.task?.state === "completed"),
        "A task update is context, not a call, and cannot disappear when a prompt exists.");
});

test("exact seek totals describe the whole conversation, including records before the target", async t => {
    const r = await reader(t, [...chatFixture(), ...coworkFixture()]);
    const conversationId = r.page.page.items.find(item => item.sourceId === "microsoft-365-cowork").id;
    const shared = { conversationId, sources: ["microsoft-365-cowork"], sourceRevision: r.page.sourceRevision };
    const whole = await r.detail("observations", { ...shared, page: { limit: 100, after: null } });
    const sought = await r.detail("observations", { ...shared, at: 4 });
    assert.equal(whole.aggregates.variants, 11);
    assert.deepEqual(whole.page.items.map(item => item.ordinal), Array.from({ length: 11 }, (_, i) => i + 3));
    assert.equal(sought.aggregates.variants, 11, "The total is not the remaining seek population.");
    assert.deepEqual(sought.page.items, whole.page.items.slice(1));
    assert.equal(sought.page.items.length, 10);
    assert.equal(sought.page.nextCursor, null, "Every record from the exact target to the end is present.");
    const first = await r.detail("observations", shared);
    const last = await r.detail("observations", { ...shared, page: { limit: 10, after: first.page.nextCursor } });
    assert.deepEqual([...first.page.items, ...last.page.items], whole.page.items);
    assert.equal(first.page.items[0].ordinal, 3, "Start-of-conversation navigation exposes the record before the seek.");
    assert.equal(last.page.nextCursor, null);
});

test("canonical reader calls join completion evidence without losing distinct input variants", async t => {
    const rows = coworkFixture(), start = structuredClone(rows[2]);
    start.record.id = "seq:14";
    start.ordering.recordOrdinal = 11;
    start.qualifiedFields.input = recorded({ query: "A distinct retained input." });
    start.record.data.inp = JSON.stringify(start.qualifiedFields.input.value);
    rows.push(start);
    const completion = rows.find(row => row.record.event === "tx" && row.record.data.tid === "invented-batch");
    completion.outcomes.nestedApi = { unit: "nested-api-result", availability: "recorded",
        observed: [{ index: 0, indexKind: "response-array-position", statusCode: 404, errorCode: null,
            paginationPresent: null, evidenceLevel: "intermediary-reported" }],
        declaredRequestCount: null, declaredRequestCountIsSuccessDenominator: false };
    const r = await reader(t, rows);
    const value = await r.detail("calls"), calls = value.page.items;
    assert.equal(value.sectionCount, 3);
    const batch = calls.find(item => item.callSummaries[0].tool === "mcp__graph__CallGraph");
    assert.equal(batch.callSummaries[0].outcome, "success", "A failed returned result is not a failed parent tool call.");
    assert.equal(new Set(batch.inputFacts.map(fact => JSON.stringify(fact.input))).size, 2);
    assert.ok(batch.evidenceFacts?.some(fact => fact.outcomes.nestedApi?.observed[0]?.statusCode === 404),
        "Returned outcomes must remain readable beside their canonical call.");
    assert.ok(batch.evidenceFacts.some(fact => fact.fields.callElapsed?.value === 12));
    const failed = calls.find(item => item.callSummaries[0].outcome === "failure");
    assert.ok(failed.evidenceFacts.some(fact => fact.fields.failure?.value.messageStatus === "text-excluded"));
});

for (const segmented of [false, true]) test(`v${segmented ? 2 : 1} reader section pages preserve original identity and complete content`, async t => {
    const r = await reader(t, [...chatFixture(), multiCallChatFixture()], segmented);
    for (const section of ["messages", "calls"]) {
        const all = await r.detail(section);
        const request = { ...r.input, section, page: { limit: 1, after: null } };
        const model = createBoundedNativeState(), owner = {}, items = [];
        let next = request;
        do {
            const ticket = model.begin(next, owner);
            const value = await r.views.detail(next, r.app.services.nativeReportAdmission);
            assert.equal(model.receive(ticket, value, owner), true);
            assert.equal(value.sectionCount, all.sectionCount);
            items.push(...value.page.items);
            next = value.page.nextCursor ? model.next() : null;
        } while (next);
        assert.deepEqual(items, all.page.items);
        assert.equal(new Set(items.map(item => item.id)).size, items.length);
        if (section === "calls") {
            assert.equal(items.length, 2, "Two calls sharing one original observation stay distinct.");
            assert.equal(items[0].ordinal, items[1].ordinal);
            const image = items.find(item => item.callSummaries[0].tool === "image_gen");
            const lookup = items.find(item => item.callSummaries[0].tool === "invented_native_lookup");
            assert.deepEqual(image.inputFacts[0].input.value, { prompt: "First invented input." });
            assert.deepEqual(lookup.inputFacts[0].input.value, { query: "Second invented input.", limit: 2 });
            assert.equal(image.callSummaries[0].outcome, "unknown");
            assert.equal(lookup.callSummaries[0].outcome, "unknown");
        }
        const previous = model.previous(), ticket = model.begin(previous, owner, undefined, true);
        model.receive(ticket, await r.views.detail(previous, r.app.services.nativeReportAdmission), owner);
        assert.equal(model.snapshot().value.page.items[0].id, items.at(-2).id);
    }
});

test("reader section cursors cannot cross sections, conversations or changed roots", async t => {
    const r = await reader(t, [...chatFixture(), multiCallChatFixture()]);
    const first = await r.detail("messages", { page: { limit: 1, after: null } });
    await assert.rejects(r.detail("context", { page: { limit: 1, after: first.page.nextCursor } }), { code: "NATIVE_VIEW_CURSOR_STALE" });
    await assert.rejects(r.detail("calls", { at: first.page.items[0].ordinal, sourceRevision: first.sourceRevision }),
        { code: "NATIVE_VIEW_INPUT_INVALID" });
    const exact = await r.detail("observations", { at: first.page.items[0].ordinal, sourceRevision: first.sourceRevision });
    assert.equal(exact.page.items[0].id, first.page.items[0].id);
    assert.equal(exact.focusOrdinal, first.page.items[0].ordinal);
    await updateBoardState(r.app.context, state => { state.continuation = "Reader fixture root changed."; });
    await assert.rejects(r.detail("messages", { page: { limit: 1, after: first.page.nextCursor } }));
});

test("closed call-section decoding rejects mismatched identity and borrowed input evidence", async t => {
    const r = await reader(t, [multiCallChatFixture()]);
    const value = await r.detail("calls"), request = { ...r.input, section: "calls" };
    for (const change of [
        item => { item.callSummaries = []; },
        item => { item.callSummaries[0].id = "f".repeat(64); },
        item => { item.inputFacts[0].ordinal = 9999; },
        item => { item.inputFacts[0].input = recorded("A borrowed input."); },
        item => { item.evidenceFacts = []; },
        item => { item.evidenceFacts[0].extra = "not in the contract"; },
        item => { item.evidenceFacts[0].retention.current = "yes"; },
        item => { item.evidenceFacts[0].fields.input.availability = "assumed"; },
        item => { item.sourceFacts = [{ kind: "task", fields: { steps: [null] } }]; },
        item => { item.inputFacts.push(structuredClone(item.inputFacts[0])); },
    ]) {
        const altered = structuredClone(value); change(altered.page.items[0]);
        assert.throws(() => createBoundedNativeState().decode(altered, request), /could not be verified/);
    }
});

test("context pages retain unavailable parts and unknown authors without substituting a prompt", async t => {
    const rows = Array.from({ length: 13 }, (_, index) => {
        const row = envelope("cowork", { id: "context:" + index, event: "rc", data: {} }, {}, {}, index);
        row.messageParts = [{ message: recorded({ author: "unknown", representation: "reply-fragment", text: "Fragment " + index }),
            evidence: { sourceDocument: "invented-parts", pointer: "/data/content/0", nativeEventId: row.record.id } }];
        return row;
    });
    const r = await reader(t, rows);
    assert.equal((await r.detail("messages")).sectionCount, 0);
    const first = await r.detail("context"), second = await r.detail("context", { page: { limit: 10, after: first.page.nextCursor } });
    assert.equal(first.sectionCount, 13);
    assert.equal(second.sectionCount, 13);
    assert.deepEqual([...first.page.items, ...second.page.items].map(item => item.messageParts[0].value.text),
        rows.map((row, index) => "Fragment " + index));
    assert.equal(second.page.nextCursor, null);
});

test("byte-short message pages preserve complete text and use only returned cursors", async t => {
    const rows = Array.from({ length: 6 }, (_, index) => envelope("cowork", { id: "large:" + index, event: "a", data: {} }, {
        message: recorded({ author: "assistant", representation: "plain-text", text: "Saved reply " + index + "\n" + "readable ".repeat(95000) }),
    }, {}, index + 1));
    const r = await reader(t, coworkFixture().slice(0, 1));
    const begun = await r.app.persistence.beginSegmented({ operationId: randomUUID() }, r.app.services.nativeReportAdmission);
    await r.app.persistence.commitSegmented(begun.ticket, rows);
    r.app.persistence.retire(begun.ticket);
    const { revision } = await loadBoardState(r.app.context);
    const first = await r.detail("messages", { revision });
    assert.ok(first.page.items.length > 0 && first.page.items.length < 6);
    assert.ok(first.page.nextCursor);
    const second = await r.detail("messages", { revision, page: { limit: 10, after: first.page.nextCursor } });
    assert.equal(second.page.nextCursor, null);
    assert.deepEqual([...first.page.items, ...second.page.items].map(item => item.fields.message.value.text),
        rows.map(row => row.qualifiedFields.message.value.text));
    assert.equal(first.sectionCount, 6);
    assert.equal(second.sectionCount, 6);
});

test("canonical input variants retain earlier and current observation provenance", async t => {
    const r = await reader(t, coworkFixture());
    const changed = coworkFixture();
    changed[2].record.data.inp = JSON.stringify({ query: "A later saved input." });
    changed[2].qualifiedFields.input = recorded({ query: "A later saved input." });
    const begun = await r.app.persistence.beginSegmented({ operationId: randomUUID() }, r.app.services.nativeReportAdmission);
    await r.app.persistence.commitSegmented(begun.ticket, changed);
    r.app.persistence.retire(begun.ticket);
    const page = await r.views.query({ schemaVersion: 1, revision: null, sources: r.input.sources,
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } }, r.app.services.nativeReportAdmission);
    const value = await r.detail("calls", { revision: page.revision });
    const batch = value.page.items.find(item => item.callSummaries[0].tool === "mcp__graph__CallGraph");
    assert.equal(batch.inputFacts.length, 2);
    const inputs = batch.evidenceFacts.filter(fact => fact.fields.input);
    assert.ok(inputs.some(fact => fact.retention.current === false && fact.fields.input.value.body));
    assert.ok(inputs.some(fact => fact.retention.current === true && fact.fields.input.value.query === "A later saved input."));
});

test("detail suspension drops private text and resumes only its accepted cursor and owner", async t => {
    const r = await reader(t, chatFixture());
    const model = createBoundedNativeState(), owner = {};
    let input = { ...r.input, section: "messages", page: { limit: 1, after: null } };
    model.receive(model.begin(input, owner), await r.views.detail(input, r.app.services.nativeReportAdmission), owner);
    input = model.next();
    model.receive(model.begin(input, owner), await r.views.detail(input, r.app.services.nativeReportAdmission), owner);
    const expected = model.snapshot(), receipt = model.suspend(owner);
    assert.ok(receipt);
    assert.equal(model.snapshot().value, null);
    assert.doesNotMatch(JSON.stringify(receipt), /invented|reply|question/);
    assert.throws(() => model.next(), TypeError);
    assert.throws(() => model.resume({}, owner), TypeError);
    assert.throws(() => model.resume(receipt, {}), TypeError);
    const resumed = model.resume(receipt, owner);
    assert.deepEqual(resumed.input, input);
    model.receive(resumed, await r.views.detail(resumed.input, r.app.services.nativeReportAdmission), owner);
    const restored = model.snapshot();
    assert.deepEqual(restored.value.page.items, expected.value.page.items);
    for (const key of ["pageIndex", "pageOffset", "pageCount", "hasNext"]) assert.equal(restored[key], expected[key]);
    assert.throws(() => model.resume(receipt, owner), TypeError);
    const withdrawn = model.suspend(owner); model.withdraw();
    assert.throws(() => model.resume(withdrawn, owner), TypeError);
});

test("resumed detail rejects root or section-count drift and cannot suspend query receipts", async t => {
    const r = await reader(t, chatFixture()), owner = {};
    for (const change of [
        value => { value.sourceRevision = "f".repeat(64); },
        value => { value.sectionCount++; value.aggregates.variants++; },
    ]) {
        const model = createBoundedNativeState(), input = { ...r.input, section: "messages" };
        const value = await r.detail("messages");
        model.receive(model.begin(input, owner), value, owner);
        const ticket = model.resume(model.suspend(owner), owner), changed = structuredClone(value);
        change(changed);
        assert.throws(() => model.receive(ticket, changed, owner), TypeError);
        assert.equal(model.snapshot().value, null);
        assert.equal(model.snapshot().pageOffset, 0);
    }
    const model = createBoundedNativeState();
    const input = { schemaVersion: 1, revision: null, sources: r.input.sources,
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } };
    model.receive(model.begin(input, owner), r.page, owner);
    assert.equal(model.suspend(owner), null);
    assert.ok(model.snapshot().value);
});
