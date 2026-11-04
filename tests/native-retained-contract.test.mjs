import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNativeSourceObservations, projectNativeRetainedObservations, projectNativeReadModel,
    projectNativeRetainedEntries, NATIVE_RETAINED_CONTRACT } from "../lib/native-read-model.mjs";
import { chatFixture, coworkFixture, imageFixture, multiCallChatFixture } from "./native-read-model-fixtures.mjs";
import { encodeNativeRetainedCapture, mergeNativeRetainedCapture, validateNativeRetainedDocument,
    isValidatedNativeRetainedRecord, filterNativeRetainedCapture } from "../lib/native-retention-contract.mjs";
import { nativeObservationDeletionAliases } from "../lib/deletion-identities.mjs";

test("new window-context snapshots cannot revive deleted activity or borrow another history's support", () => {
    const source = coworkFixture();
    const snapshot = source.find(row => row.record.task);
    const event = source.find(row => row.record.event === "ts");
    snapshot.coverage.push({ kind: "native-history-snapshot", meaning: "Undated supporting snapshot." });
    event.record.data.ts = 1800000000000;
    event.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
        unit: "epoch-ms", basis: "cowork.data.ts", value: event.record.data.ts };
    event.evidenceReferences.observationTime = { sourceDocument: event.capture.captureId,
        pointer: "/events/0/data/ts", nativeEventId: event.record.id };
    event.coverage.push({ kind: "native-history-window", meaning: "Qualified in-window event." });
    const account = { partition: "a".repeat(64), issuer: "https://source.example.invalid",
        tenantId: snapshot.scope.account.tenantId, subjectId: snapshot.scope.account.subjectId };
    const capture = encodeNativeRetainedCapture(account, [snapshot, event]);
    const eventKey = capture.observations[1].key;
    const deletion = { identities: nativeObservationDeletionAliases(eventKey) };
    assert.equal(filterNativeRetainedCapture(capture, {}).capture.observations.length, 2);
    const suppressed = filterNativeRetainedCapture(capture, deletion);
    assert.equal(suppressed.suppressedObservations, 2);
    assert.deepEqual(suppressed.capture.observations, []);
    assert.deepEqual(suppressed.capture.captures, []);
    const later = structuredClone(event);
    later.record.id += "-later";
    later.evidenceReferences.observationTime.nativeEventId = later.record.id;
    const next = filterNativeRetainedCapture(encodeNativeRetainedCapture(account, [snapshot, event, later]), deletion);
    assert.equal(next.capture.observations.length, 2);
    assert.equal(next.suppressedObservations, 1);
    later.scope.conversationId += "-other";
    assert.equal(filterNativeRetainedCapture(encodeNativeRetainedCapture(account, [snapshot, event, later]),
        deletion).capture.observations.length, 1);
    snapshot.coverage = snapshot.coverage.filter(row => row.kind !== "native-history-snapshot");
    assert.equal(filterNativeRetainedCapture(encodeNativeRetainedCapture(account, [snapshot]), {})
        .capture.observations.length, 1, "Existing standalone snapshot contracts are not reinterpreted.");
});

test("the successor codec validates normalized source facts without retaining a raw carrier", () => {
    for (const source of [chatFixture(), coworkFixture(), imageFixture(), [multiCallChatFixture()]]) {
        const qualified = normalizeNativeSourceObservations(source);
        assert.equal(qualified.contractVersion, NATIVE_RETAINED_CONTRACT);
        assert.ok(qualified.records.every(record => !Object.hasOwn(record, "record")));
        const decoded = projectNativeRetainedObservations(JSON.parse(JSON.stringify(qualified)));
        assert.deepEqual(decoded.conversations, projectNativeReadModel(source).conversations);
        assert.equal(decoded.admission.admitted, false);
    }
});

test("independent URL and contact text survives normalization, retained encoding and disk-shaped readback", () => {
    const source = chatFixture().slice(0, 2);
    source[0].qualifiedFields.message.value.text = "https://example.test";
    source[1].qualifiedFields.message.value.text = "reader@example.test";
    const expected = projectNativeReadModel(source);
    const normalized = normalizeNativeSourceObservations(source);
    assert.deepEqual(projectNativeRetainedObservations(normalized).conversations, expected.conversations);
    const account = { partition: "e".repeat(64), issuer: "https://source.example.invalid",
        tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId };
    const saved = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, source));
    const restored = validateNativeRetainedDocument(JSON.parse(JSON.stringify(saved.document)));
    const projected = projectNativeRetainedObservations(restored);
    assert.deepEqual(projected.conversations[0].messages.map(message => message.value),
        expected.conversations[0].messages.map(message => message.value));
    assert.deepEqual(restored.records.map(record => record.identity), normalized.records.map(record => record.identity));
});

test("source identity reuses unchanged facts while preserving capture provenance and changed variants", () => {
    const source = coworkFixture();
    const account = { partition: "a".repeat(64), issuer: "https://source.example.invalid",
        tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId };
    const first = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, source));
    const repeated = structuredClone(source);
    for (const row of repeated) {
        row.capture.captureId += "-next";
        row.capture.generation++;
        row.ordering.pageOrdinal++;
        row.ordering.recordOrdinal += 100;
    }
    const next = mergeNativeRetainedCapture(first.document, encodeNativeRetainedCapture(account, repeated));
    assert.equal(next.document.observations.length, first.document.observations.length);
    assert.equal(next.changes.addedVariants, 0);
    assert.equal(next.changes.reusedObservations, source.length);
    assert.equal(next.changes.addedProvenance, source.length);
    const changed = structuredClone(repeated);
    const row = changed.find(item => item.record.event === "ts" && item.qualifiedFields.input?.availability === "recorded");
    row.capture.captureId += "-changed";
    row.record.data.inp = { query: "changed non-secret value" };
    row.qualifiedFields.input.value = structuredClone(row.record.data.inp);
    const latest = mergeNativeRetainedCapture(next.document, encodeNativeRetainedCapture(account, changed));
    assert.equal(latest.changes.addedVariants, 1);
    const restored = validateNativeRetainedDocument(JSON.parse(JSON.stringify(latest.document)));
    assert.equal(restored.records.filter(record => record.retention.current === false).length, 1);
    const entries = restored.records.map((record, inputOrdinal) => ({ inputOrdinal, record })).reverse();
    const copied = structuredClone(entries);
    assert.ok(entries.every(entry => isValidatedNativeRetainedRecord(entry.record)));
    assert.ok(copied.every(entry => !isValidatedNativeRetainedRecord(Object.freeze(entry.record))));
    assert.deepEqual(projectNativeRetainedEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries }),
        projectNativeRetainedEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries: copied }));
    const invalid = structuredClone(entries);
    invalid[0].record.identity = {};
    Object.freeze(invalid[0].record);
    assert.throws(() => projectNativeRetainedEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries: invalid }),
        { name: "NativeReadModelError" });
    assert.throws(() => projectNativeRetainedEntries({ contractVersion: NATIVE_RETAINED_CONTRACT,
        entries: [{ inputOrdinal: -1, record: entries[0].record }] }), { name: "NativeReadModelError" });
    assert.equal(projectNativeRetainedObservations(restored).conversations[0].calls.length,
        projectNativeReadModel(source).conversations[0].calls.length);
    assert.equal(first.document.observations.every(item => item.variants.length === 1), true);
});

test("an empty later source response preserves retained history without creating provenance", () => {
    const source = chatFixture();
    const account = { partition: "b".repeat(64), issuer: "https://source.example.invalid",
        tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId };
    const first = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, source));
    const later = mergeNativeRetainedCapture(first.document, encodeNativeRetainedCapture(account, []));
    assert.deepEqual(later.document, first.document);
    assert.ok(Object.values(later.changes).every(count => count === 0));
});

test("identical content with a different native identity remains a distinct retained observation", () => {
    const source = [chatFixture()[0]];
    const account = { partition: "c".repeat(64), issuer: "https://source.example.invalid",
        tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId };
    const other = structuredClone(source[0]);
    other.record.messageId += "-distinct";
    other.record.storageMessageId += "-distinct";
    const saved = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, [...source, other]));
    assert.equal(saved.document.observations.length, 2);
    assert.equal(saved.changes.addedObservations, 2);
    assert.equal(saved.changes.reusedObservations, 0);
});

test("retained projection rejects raw carriers, UI projections, malformed facts and unsupported contracts", () => {
    const source = chatFixture();
    const normalized = normalizeNativeSourceObservations(source);
    for (const value of [
        source,
        projectNativeReadModel(source),
        { ...normalized, contractVersion: "unsupported" },
        { ...normalized, records: [{ ...normalized.records[0], record: source[0].record }] },
        { ...normalized, records: [{ ...normalized.records[0], identity: {} }] },
        { ...normalized, records: [{ ...normalized.records[0], fields: { fabricated: { availability: "recorded", value: true } } }] },
    ]) assert.throws(() => projectNativeRetainedObservations(value), { name: "NativeReadModelError" });
});

test("the stored contract rejects unreferenced capture objects outside source validation", () => {
    const source = chatFixture();
    const account = { partition: "d".repeat(64), issuer: "https://source.example.invalid",
        tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId };
    const saved = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, source));
    const altered = structuredClone(saved.document);
    altered.captures.push({ key: "unreferenced", value: { record: "unvalidated raw carrier" } });
    assert.throws(() => validateNativeRetainedDocument(altered), { code: "native-retained-capture-unreferenced" });
    assert.equal(Object.isFrozen(saved.document.captures[0].value), true);
});
