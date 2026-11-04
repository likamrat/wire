import test from "node:test";
import assert from "node:assert/strict";
import { createChartReferenceState } from "./chart-reference-state.mjs";

test("opening chart help changes presentation only", () => {
    const state = createChartReferenceState();
    assert.deepEqual(state.value(), { view: "closed", topic: "outcomes" });
    assert.deepEqual(state.open("time"), { view: "guide", topic: "time" });
    assert.deepEqual(state.value(), { view: "guide", topic: "time" });
});

test("exact numbers return to the same guide topic", () => {
    const state = createChartReferenceState();
    state.open("services");
    assert.deepEqual(state.showData(), { view: "data", topic: "services" });
    assert.deepEqual(state.back(), { view: "guide", topic: "services" });
});

test("the flat topic index retains the last topic and opens the chosen guide", () => {
    const state = createChartReferenceState();
    state.open("services");
    assert.deepEqual(state.showIndex(), { view: "index", topic: "services" });
    assert.deepEqual(state.selectTopic("time"), { view: "guide", topic: "time" });
});

test("the index cannot open exact data before a topic is chosen", () => {
    const state = createChartReferenceState();
    assert.throws(() => state.showIndex(), /Open chart help/);
    state.open("models");
    state.showIndex();
    assert.throws(() => state.showData(), /guide/);
    assert.deepEqual(state.value(), { view: "index", topic: "models" });
    state.close();
    assert.deepEqual(state.open(), { view: "guide", topic: "models" });
});

test("closing and reopening retains only the last topic", () => {
    const state = createChartReferenceState();
    state.open("tools");
    state.selectTopic("models");
    state.showData();
    assert.deepEqual(state.close(), { view: "closed", topic: "models" });
    assert.deepEqual(state.open(), { view: "guide", topic: "models" });
});

test("unsupported topics fail without changing the presentation", () => {
    const state = createChartReferenceState();
    state.open("outcomes");
    for (const topic of ["", "comparison", "unknown", null, 4]) {
        assert.throws(() => state.selectTopic(topic), TypeError);
        assert.throws(() => state.open(topic), TypeError);
    }
    assert.deepEqual(state.value(), { view: "guide", topic: "outcomes" });
});

test("hidden help cannot enter data or change a topic", () => {
    const state = createChartReferenceState();
    assert.throws(() => state.showData(), /Open chart help/);
    assert.throws(() => state.selectTopic("models"), /Open chart help/);
    assert.throws(() => state.back(), /exact chart data/);
    assert.deepEqual(state.value(), { view: "closed", topic: "outcomes" });
});
