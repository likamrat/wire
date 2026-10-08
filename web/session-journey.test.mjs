import test from "node:test";
import assert from "node:assert/strict";
import { createSessionJourney } from "./session-journey.mjs";

test("choosing another session clears incompatible filters; a result link preserves the exact slice", () => {
    const journey = createSessionJourney();
    const previous = { view: "activity", session: "a", project: "wrong-project", search: "private", result: "success", endpoint: "old-path", layer: "tool", range: "custom", from: "2026-09-01", to: "2026-09-30", service: "Calendar", scope: "all", page: "2" };
    assert.deepEqual(journey.open(previous, "b"), { view: "activity", session: "b", layer: "tool", range: "custom", from: "2026-09-01", to: "2026-09-30", service: "Calendar", scope: "all" });
    assert.deepEqual(journey.open(previous, "b", "failure"), { ...previous, session: "b", view: "activity", request: undefined, page: undefined, result: "failure", origin: undefined });
    assert.deepEqual(journey.open(previous, "b", "success"), { ...previous, session: "b", view: "activity", request: undefined, page: undefined, result: "success", origin: undefined });
});

test("session report selects canonical owners across pages, never same-name sessions or aliases", () => {
    const journey = createSessionJourney();
    const catalog = { requests: [
        ...Array.from({ length: 17 }, (_, i) => ({ scenarioId: "a-" + i, sourceSessionId: "a", aliases: ["a-" + i, "old-" + i] })),
        { scenarioId: "b-1", sourceSessionId: "b", aliases: ["b-1"] },
    ] };
    assert.deepEqual(journey.reportIds(catalog, "a"), Array.from({ length: 17 }, (_, i) => "a-" + i));
    assert.deepEqual(journey.reportIds(catalog, "missing"), []);
    assert.equal(journey.reportIds(undefined, "a"), null);
    assert.equal(journey.reportIds({ requests: [{ scenarioId: "broken" }] }, "a"), null);
});
