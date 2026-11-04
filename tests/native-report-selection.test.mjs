import test from "node:test";
import assert from "node:assert/strict";
import { nativeReportSelectionExpectations, assertNativeReportSelection } from "../lib/native-report-selection.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { normalizeNativeSourceObservations } from "../lib/native-read-model.mjs";
import { chatFixture } from "./native-read-model-fixtures.mjs";

const key = "7".repeat(64);
const source = () => projectRetainedNativeRecords(normalizeNativeSourceObservations(chatFixture()));

test("native report selection binds complete canonical records and interpretation definitions", () => {
    const frame = source(), expected = nativeReportSelectionExpectations(frame.records, frame.definitions, key);
    assert.equal(expected.length, 1);
    assert.match(expected[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(assertNativeReportSelection(expected, frame.records, frame.definitions, key), true);
    const changed = structuredClone(frame.records);
    changed[0].nativeConversation.messages[0].value.text += " Changed.";
    assert.throws(() => assertNativeReportSelection(expected, changed, frame.definitions, key), { status: 409 });
    assert.throws(() => assertNativeReportSelection(expected, frame.records,
        { ...frame.definitions, ordering: "A changed interpretation." }, key), { status: 409 });
    assert.equal(JSON.stringify(expected).includes("An invented question"), false);
});

test("native report dependencies include provenance and reject malformed or expanded expectations", () => {
    const frame = source(), expected = nativeReportSelectionExpectations(frame.records, frame.definitions, key);
    const changed = structuredClone(frame.records);
    changed[0].nativeConversation.observations[0].capture.generation++;
    assert.throws(() => assertNativeReportSelection(expected, changed, frame.definitions, key), { status: 409 });
    assert.throws(() => assertNativeReportSelection([], frame.records, frame.definitions, key), { status: 409 });
    assert.throws(() => assertNativeReportSelection([...expected, ...expected], frame.records, frame.definitions, key), { status: 422 });
    assert.throws(() => assertNativeReportSelection([{ ...expected[0], owner: "not-authority" }], frame.records, frame.definitions, key), { status: 422 });
    assert.throws(() => assertNativeReportSelection([{ ...expected[0], fingerprint: [expected[0].fingerprint] }], frame.records, frame.definitions, key), { status: 422 });
    assert.throws(() => nativeReportSelectionExpectations(frame.records, undefined, key), { status: 422 });
    const reorderedDefinitions = Object.fromEntries(Object.entries(frame.definitions).reverse());
    assert.deepEqual(nativeReportSelectionExpectations(frame.records, reorderedDefinitions, key), expected);
    assert.ok(Object.isFrozen(expected) && Object.isFrozen(expected[0]));
});
