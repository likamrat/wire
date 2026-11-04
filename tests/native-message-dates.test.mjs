import test from "node:test";
import assert from "node:assert/strict";
import { chatSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { normalizeNativeMessageTime, retainNativeChatSourceObservations, normalizeNativeSourceObservations,
    projectNativeRetainedObservations, projectNativeReadModel } from "../lib/native-read-model.mjs";
import { encodeNativeRetainedCapture, mergeNativeRetainedCapture, validateNativeRetainedDocument } from "../lib/native-retention-contract.mjs";
import { projectRetainedNativeRecords, nativeActivityRows, nativeObservationInstant } from "../lib/retained-population.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { time } from "../lib/time.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";

function datedSource({ created = "2026-01-01T23:30:00.123456789-08:00", updated = "2026-02-01T00:00:00Z",
    messageType = "Chat", calls = 0 } = {}) {
    const original = { messageId: "invented-dated-message", storageMessageId: "invented-dated-storage",
        author: "bot", text: "An existing message.", ...(messageType === null ? {} : { messageType }),
        ...(calls ? { invocation: JSON.stringify(Array.from({ length: calls }, (_, index) => ({
            id: `invented-date-call-${index}`, type: "function", function: { name: "invented_lookup", arguments: {} },
        }))) } : {}) };
    const [row] = retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource(original)));
    for (const [name, field, value] of [["messageCreatedAt", "createdAt", created], ["messageUpdatedAt", "timestamp", updated]]) {
        if (value !== undefined) row.record[field] = value;
        row.qualifiedFields[name] = { scope: "message", ...(value === undefined
            ? { availability: "absent-in-response", reason: "field-absent-from-response" }
            : { availability: value === null ? "explicit-null" : value === "" ? "recorded-empty" : "recorded", value }) };
        row.evidenceReferences[name] = { sourceDocument: row.chatSource.source.sourceDocument,
            pointer: `${row.chatSource.source.pointer}/${field}`, nativeEventId: original.messageId };
    }
    return row;
}
const options = { layer: "tool", bucket: "day", timeContext: { timeZone: "UTC", locale: "en-US" },
    filters: { scope: "all", from: "2026-01-02", to: "2026-01-02" } };

test("message time normalization preserves explicit source precision and rejects guessed or invalid dates", () => {
    assert.equal(normalizeNativeMessageTime("2026-01-01T23:30:00.123456789-08:00"), "2026-01-02T07:30:00.123Z");
    for (const value of ["2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T00:00:00",
        "2026-01-01T24:00:00Z", "2026-01-01T00:00:00.1234567890Z", 1767225600000, null]) {
        assert.throws(() => normalizeNativeMessageTime(value), { code: "invalid-native-message-time" });
    }
});

test("SCREENED message time round-trip preserves original values and references, never call clocks", () => {
    for (const calls of [0, 1, 2]) {
        const row = datedSource({ calls }), normalized = normalizeNativeSourceObservations([row]);
        assert.deepEqual(projectNativeRetainedObservations(normalized).conversations, projectNativeReadModel([row]).conversations);
        const account = { partition: "d".repeat(64), issuer: "https://source.example.invalid",
            tenantId: row.scope.account.tenantId, subjectId: row.scope.account.subjectId };
        const first = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, [row]));
        const repeated = structuredClone(row); repeated.capture.captureId += "-repeat";
        const next = mergeNativeRetainedCapture(first.document, encodeNativeRetainedCapture(account, [repeated]));
        assert.equal(next.changes.addedVariants, 0);
        assert.equal(next.changes.addedProvenance, 1);
        const restored = validateNativeRetainedDocument(JSON.parse(JSON.stringify(next.document)));
        assert.deepEqual(restored.records[0].fields, normalized.records[0].fields);
        const conversation = projectNativeRetainedObservations(restored).conversations[0];
        assert.equal(conversation.observations[0].fields.messageCreatedAt.value, row.record.createdAt);
        assert.equal(conversation.observations[0].fields.messageCreatedAt.calendarInstant, "2026-01-02T07:30:00.123Z");
        assert.deepEqual(conversation.measurements, []);
        for (const call of conversation.calls) for (const observation of call.observations) {
            assert.equal(Object.hasOwn(observation.fields, "messageCreatedAt"), false);
            assert.equal(Object.hasOwn(observation.fields, "messageUpdatedAt"), false);
        }
    }
});

test("Cowork observation time preserves original units and evidence through retained readback and time projection", () => {
    const iso = "2026-01-01T23:30:00.123456789-08:00", instant = "2026-01-02T07:30:00.123Z";
    for (const [unit, original] of [["iso8601", iso], ["epoch-ms", Date.parse(instant)]]) {
        const rows = coworkFixture().filter(row => ["ts", "tx"].includes(row.record.event));
        for (const row of rows) {
            row.record.data.ts = original;
            row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
                unit, basis: "cowork.data.ts", value: original };
            row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
                pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
        }
        const account = { partition: "d".repeat(64), issuer: "https://source.example.invalid",
            tenantId: rows[0].scope.account.tenantId, subjectId: rows[0].scope.account.subjectId };
        const captured = encodeNativeRetainedCapture(account, rows);
        const first = mergeNativeRetainedCapture(null, captured);
        const repeat = structuredClone(rows);
        for (const row of repeat) row.capture.captureId += "-repeat";
        const merged = mergeNativeRetainedCapture(first.document, encodeNativeRetainedCapture(account, repeat));
        assert.equal(merged.changes.addedVariants, 0);
        const retained = validateNativeRetainedDocument(JSON.parse(JSON.stringify(merged.document)));
        for (const [index, record] of retained.records.entries()) {
            assert.deepEqual(record.fields.observationTime, {
                ...rows[index].qualifiedFields.observationTime, calendarInstant: instant,
                evidence: [rows[index].evidenceReferences.observationTime],
            });
        }
        const projected = projectRetainedNativeRecords(retained);
        const analytics = buildActivityAnalytics(projected.records, options);
        assert.equal(analytics.rows.length, 2, "Only calls with an observed start are dated; completion-only calls remain undated.");
        assert.ok(analytics.rows.every(row => row.startedAt === instant));
        assert.ok(analytics.timeSeries.points.length > 0);
        assert.equal(analytics.measurementEligibility.nativeActivityDates, "source-observation-qualified");
        assert.equal(analytics.population.coverage.nativeActivityDates, "source-observation-qualified");
        assert.equal(analytics.totals.duration.sampleCount, 0, "An observation instant is not a duration.");
    }
});

test("Cowork time refuses ambiguous units and crossed evidence and never substitutes capture or completion times", () => {
    const rows = coworkFixture(), row = rows.find(value => value.record.event === "ts");
    const original = "2026-01-02T07:30:00.123Z";
    row.record.data.ts = original;
    row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
        unit: "iso8601", basis: "cowork.data.ts", value: original };
    row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
        pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
    for (const change of [
        value => { delete value.qualifiedFields.observationTime.unit; },
        value => { value.qualifiedFields.observationTime.unit = "seconds"; },
        value => { value.qualifiedFields.observationTime.unit = "epoch-ms"; },
        value => { value.qualifiedFields.observationTime.value = value.record.data.ts = "2026-02-30T00:00:00Z"; },
        value => { value.qualifiedFields.observationTime.value = value.record.data.ts = "2026-01-02"; },
        value => { value.qualifiedFields.observationTime.value = value.record.data.ts = 1.5; value.qualifiedFields.observationTime.unit = "epoch-ms"; },
        value => { value.qualifiedFields.observationTime.value = value.record.data.ts = Number.MAX_SAFE_INTEGER; value.qualifiedFields.observationTime.unit = "epoch-ms"; },
        value => { value.qualifiedFields.observationTime.scope = "call"; },
        value => { value.qualifiedFields.observationTime.basis = "capture.capturedAt"; },
        value => { value.qualifiedFields.observationTime.calendarInstant = original; },
        value => { value.record.data.ts = "2026-01-03T00:00:00Z"; },
        value => { value.evidenceReferences.observationTime.nativeEventId = "seq:4"; },
        value => { value.evidenceReferences.observationTime.pointer = "/events/*/data/ts"; },
        value => { value.evidenceReferences.observationTime.pointer = "/capture/capturedAt"; },
    ]) {
        const value = structuredClone(row); change(value);
        assert.throws(() => normalizeNativeSourceObservations([value]), { name: "NativeReadModelError" });
    }
    const retained = normalizeNativeSourceObservations([row]);
    for (const change of [
        value => { delete value.fields.observationTime.calendarInstant; },
        value => { value.fields.observationTime.calendarInstant = "2026-01-03T00:00:00.000Z"; },
        value => { value.fields.observationTime.evidence[0].nativeEventId = "seq:4"; },
        value => { value.fields.observationTime.unit = "epoch-ms"; },
    ]) {
        const value = structuredClone(retained); change(value.records[0]);
        assert.throws(() => projectNativeRetainedObservations(value), { name: "NativeReadModelError" });
    }
    const unavailable = [
        { availability: "absent-in-response", reason: "field-absent-from-response" },
        { availability: "explicit-null", value: null },
        { availability: "recorded-empty", value: "" },
        { availability: "unqualified", reason: "timestamp-unit-unqualified" },
    ];
    for (const fact of unavailable) {
        const value = structuredClone(row);
        value.qualifiedFields.observationTime = { ...fact, scope: "observation", basis: "cowork.data.ts" };
        if (Object.hasOwn(fact, "value")) value.record.data.ts = fact.value;
        else if (fact.availability === "absent-in-response") delete value.record.data.ts;
        const normalized = normalizeNativeSourceObservations([value]);
        assert.equal(Object.hasOwn(normalized.records[0].fields.observationTime, "calendarInstant"), false);
        const projected = projectRetainedNativeRecords(normalized);
        assert.equal(nativeObservationInstant(projected.records[0].nativeConversation.observations[0]), null);
        assert.equal(nativeActivityRows(projected.records, "tool")[0].startedAt, null);
    }
    const tx = rows.find(value => value.record.event === "tx");
    tx.record.data.ts = original;
    tx.qualifiedFields.observationTime = structuredClone(row.qualifiedFields.observationTime);
    tx.evidenceReferences.observationTime = { ...row.evidenceReferences.observationTime, nativeEventId: tx.record.id };
    assert.equal(nativeActivityRows(projectRetainedNativeRecords(normalizeNativeSourceObservations([tx])).records, "tool")[0].startedAt, null);
    for (const carrier of [chatFixture()[0], rows.find(value => value.record.task)]) {
        carrier.qualifiedFields.observationTime = structuredClone(row.qualifiedFields.observationTime);
        carrier.evidenceReferences.observationTime = structuredClone(row.evidenceReferences.observationTime);
        assert.throws(() => normalizeNativeSourceObservations([carrier]), { code: "observation-time-source-unqualified" });
    }
    const undated = coworkFixture().find(value => value.record.event === "ts");
    const account = { partition: "d".repeat(64), issuer: "https://source.example.invalid",
        tenantId: undated.scope.account.tenantId, subjectId: undated.scope.account.subjectId };
    const old = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, [undated])).document;
    const oldBytes = JSON.stringify(old);
    const updated = mergeNativeRetainedCapture(old, encodeNativeRetainedCapture(account, [row])).document;
    assert.equal(JSON.stringify(old), oldBytes);
    assert.equal(updated.observations[0].key, old.observations[0].key);
    assert.equal(updated.observations[0].variants.length, 2);
    assert.equal(Object.hasOwn(validateNativeRetainedDocument(JSON.parse(oldBytes)).records[0].fields, "observationTime"), false);
    const reverted = mergeNativeRetainedCapture(updated, encodeNativeRetainedCapture(account, [undated])).document;
    const projected = projectRetainedNativeRecords(validateNativeRetainedDocument(reverted));
    assert.equal(nativeActivityRows(projected.records, "tool")[0].startedAt, null, "An undated current variant never inherits its historic timestamp.");
});

test("source and retained time facts reject conflicting values, derived metadata, roles and evidence", () => {
    const source = datedSource();
    for (const alter of [
        row => { row.record.createdAt = "2025-01-01T00:00:00Z"; },
        row => { row.qualifiedFields.messageCreatedAt.scope = "call"; },
        row => { row.qualifiedFields.messageCreatedAt.calendarInstant = "2026-01-02T07:30:00.123Z"; },
        row => { row.evidenceReferences.messageCreatedAt.pointer = row.evidenceReferences.messageUpdatedAt.pointer; },
        row => { delete row.chatSource; },
    ]) {
        const row = structuredClone(source); alter(row);
        assert.throws(() => normalizeNativeSourceObservations([row]), { name: "NativeReadModelError" });
    }
    const normalized = normalizeNativeSourceObservations([source]);
    for (const alter of [
        row => { row.fields.messageCreatedAt.calendarInstant = "2025-01-01T00:00:00.000Z"; },
        row => { delete row.fields.messageCreatedAt.calendarInstant; },
        row => { row.fields.messageCreatedAt.scope = "call"; },
        row => { row.fields.messageCreatedAt.evidence[0].pointer = row.fields.messageUpdatedAt.evidence[0].pointer; },
        row => { row.fields.messageCreatedAt.evidence[0].nativeEventId = row.identity.id; },
        row => { delete row.chatSource; },
    ]) {
        const value = structuredClone(normalized); alter(value.records[0]);
        assert.throws(() => projectNativeRetainedObservations(value), { name: "NativeReadModelError" });
    }
});

test("empty, null and absent message times stay unavailable, without capture or update fallback", () => {
    for (const value of ["", null, undefined]) {
        const source = datedSource();
        if (value === undefined) {
            delete source.record.createdAt;
            source.qualifiedFields.messageCreatedAt = { scope: "message", availability: "absent-in-response", reason: "field-absent-from-response" };
        } else {
            source.record.createdAt = value;
            source.qualifiedFields.messageCreatedAt = { scope: "message", availability: value === null ? "explicit-null" : "recorded-empty", value };
        }
        const normalized = normalizeNativeSourceObservations([source]);
        assert.equal(Object.hasOwn(normalized.records[0].fields.messageCreatedAt, "calendarInstant"), false);
        const records = projectRetainedNativeRecords(normalized).records;
        assert.deepEqual(buildActivityAnalytics(records, options).population.scenarioIds, []);
        const conflict = structuredClone(normalized);
        conflict.records[0].fields.messageCreatedAt.calendarInstant = "2026-01-02T00:00:00.000Z";
        assert.throws(() => projectNativeRetainedObservations(conflict), { code: "retained-message-time-conflict" });
    }
});

test("Dates admit ordinary creation context only, with strict facets and unchanged measured denominators", () => {
    for (const messageType of ["Chat", null]) {
        const records = projectRetainedNativeRecords(normalizeNativeSourceObservations([datedSource({ messageType, calls: 1 })])).records;
        const value = buildActivityAnalytics(records, options);
        assert.deepEqual(value.population.contextOnlyScenarioIds, [records[0].scenarioId]);
        assert.equal(value.population.coverage.messageCreationDatesAvailable, true);
        assert.equal(value.totals.count, 0);
        assert.deepEqual(value.timeSeries.points, []);
        assert.equal(value.totals.duration.sampleCount, 0);
        for (const filter of [{ tools: ["invented_lookup"] }, { outcomes: ["unknown"] }, { services: ["Mail"], includeMissingService: true },
            { sources: ["microsoft-365-cowork"] }, { sourceSessionIds: ["different"] }, { promptAuthors: ["user"] }]) {
            assert.deepEqual(buildActivityAnalytics(records, { ...options, filters: { ...options.filters, ...filter } }).population.scenarioIds, []);
        }
        const all = buildActivityAnalytics(records, { ...options, filters: { scope: "all" } });
        assert.equal(all.rows.length, 1);
        assert.equal(all.rows[0].startedAt, null);
        assert.deepEqual(all.population.contextOnlyScenarioIds, []);
        assert.deepEqual(buildActivityAnalytics(records, { ...options, filters: { ...options.filters, from: "2026-02-01", to: "2026-02-01" } }).population.scenarioIds, []);
        const local = buildActivityAnalytics(records, { ...options, timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" },
            filters: { ...options.filters, from: "2026-01-01", to: "2026-01-01" } });
        assert.deepEqual(local.population.contextOnlyScenarioIds, [records[0].scenarioId]);
    }
    const progress = projectRetainedNativeRecords(normalizeNativeSourceObservations([datedSource({ messageType: "Progress" })])).records;
    assert.deepEqual(buildActivityAnalytics(progress, options).population.scenarioIds, []);
});

test("shared and serialized narrowing preserve orphan rows and cannot expand context membership", () => {
    const records = projectRetainedNativeRecords(normalizeNativeSourceObservations([datedSource()])).records;
    const base = buildActivityAnalytics(records, options).population;
    for (const factory of [createActivityProjection, Function(`return (${createActivityProjection.toString()});`)()]) {
        const projection = factory(time, serviceCategories, OUTCOMES);
        assert.deepEqual(projection.narrowPopulation(base, [], [], records).contextOnlyScenarioIds, []);
        assert.equal(projection.narrowPopulation(base, [], [], records).coverage.messageCreationDatesAvailable, false);
        assert.throws(() => projection.narrowPopulation(base, ["unaccepted"], [], records), TypeError);
        const orphan = { id: "accepted-orphan", scenarioId: "missing-parent", countUnit: "github-tool-call" };
        const withOrphan = { ...base, rowIds: [orphan.id], units: [orphan.countUnit],
            rowScenarioIds: [orphan.scenarioId], rowUnits: [orphan.countUnit] };
        const narrowed = projection.narrowPopulation(withOrphan, [], [orphan], records);
        assert.deepEqual(narrowed.rowIds, [orphan.id]);
        assert.deepEqual(narrowed.rowScenarioIds, [orphan.scenarioId]);
        assert.deepEqual(narrowed.rowUnits, [orphan.countUnit]);
        assert.deepEqual(narrowed.scenarioIds, []);
        assert.equal(narrowed.native.conversations, 0);
        for (const field of ["rowScenarioIds", "rowUnits"]) {
            assert.throws(() => projection.narrowPopulation({ ...base, [field]: undefined }, [], [], records), TypeError);
        }
        const owned = { ...orphan, scenarioId: records[0].scenarioId };
        assert.throws(() => projection.narrowPopulation(withOrphan, [], [owned], records), TypeError);
        const measuredRecords = projectRetainedNativeRecords(normalizeNativeSourceObservations([datedSource({ calls: 1 })])).records;
        const measured = buildActivityAnalytics(measuredRecords, { ...options, filters: { scope: "all" } });
        const relabeled = { ...measured.rows[0], scenarioId: "unaccepted-parent" };
        assert.throws(() => projection.narrowPopulation(measured.population, [], [relabeled], measuredRecords), TypeError);
        const extraUnit = { ...measured.population, units: [...measured.population.units, "github-tool-call"] };
        assert.throws(() => projection.narrowPopulation(extraUnit, measured.population.scenarioIds,
            [{ ...measured.rows[0], countUnit: "github-tool-call" }], measuredRecords), TypeError);
    }
});

test("Compare manual and strict Search context never becomes a measured or assessment cohort", () => {
    const { state } = qualityDisplayFixture({ requests: 1, calls: 1, timed: 1 });
    const records = projectRetainedNativeRecords(normalizeNativeSourceObservations([datedSource({ calls: 1 })])).records;
    const input = { schemaVersion: 1, expectedRevision: state.revision,
        options: { ...options, filters: { scope: "all" } },
        periods: { baseline: { from: "2026-01-02", to: "2026-01-02" }, later: { from: "2026-02-01", to: "2026-02-01" } },
        scenarioIds: [records[0].scenarioId], withinServices: [] };
    const compared = buildPeriodComparison(state, input, { scenarios: records });
    assert.deepEqual(compared.periods.baseline.analytics.population.contextOnlyScenarioIds, input.scenarioIds);
    assert.deepEqual(compared.periods.baseline.scenarioIds, []);
    assert.deepEqual(compared.periods.baseline.interactionRefs, []);
    assert.deepEqual(compared.periods.later.analytics.population.scenarioIds, []);
    for (const refinement of [{ scenarioIds: [] }, { withinServices: ["Mail"] }]) {
        assert.deepEqual(buildPeriodComparison(state, { ...input, ...refinement }, { scenarios: records })
            .periods.baseline.analytics.population.scenarioIds, []);
    }
    const receipt = { schemaVersion: searchWireContract.schemaVersion, panelId: "00000000-0000-4000-8000-000000000001",
        epoch: 0, requestId: 1, generation: 1, indexId: "1".repeat(64), mode: "text", revision: state.revision,
        purpose: "strict-match-population", queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes],
        matchPolicyId: searchWireContract.matchPolicyId };
    const { scenarioIds, ...request } = input;
    const semantic = { ...request, semanticSelection: { receipt } };
    const membership = { scenarioIds, actionIds: [], parentScenarioIds: [] };
    assert.deepEqual(buildPeriodComparison(state, semantic, { scenarios: records, semanticMembership: membership })
        .periods.baseline.analytics.population.contextOnlyScenarioIds, scenarioIds);
    assert.deepEqual(buildPeriodComparison(state, { ...semantic, semanticSelection: { receipt, withinScenarioIds: [] } },
        { scenarios: records, semanticMembership: membership }).periods.baseline.analytics.population.scenarioIds, []);
    const actionOnly = { scenarioIds: [], actionIds: [records[0].nativeConversation.calls[0].key], parentScenarioIds: scenarioIds };
    assert.deepEqual(buildPeriodComparison(state, semantic, { scenarios: records, semanticMembership: actionOnly })
        .periods.baseline.analytics.population.scenarioIds, []);
});
