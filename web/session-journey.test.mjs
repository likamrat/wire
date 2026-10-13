import test from "node:test";
import assert from "node:assert/strict";
import { createSessionJourney } from "./session-journey.mjs";

test("Analyze aliases keep the exact filter, private query and paging state", () => {
    const journey = createSessionJourney();
    const scope = { services: "Files", includeMissingService: false, authors: "user", result: "failure",
        session: "invented-chat", page: "2", search: "private phrase", localSearch: { settingsSearch: "display" } };
    for (const view of ["analyze", "home", "overview", "activity"]) {
        assert.deepEqual(journey.canonical({ ...scope, view }), { ...scope, view: "analyze" });
    }
    assert.deepEqual(journey.canonical({ ...scope, view: "calls" }), { ...scope, view: "analyze", mode: "calls" });
    assert.deepEqual(journey.canonical({ ...scope, view: "request", request: "invented-request" }),
        { ...scope, view: "request", request: "invented-request" });
});

test("chat context stays in Analyze and a result link opens matching Calls", () => {
    const journey = createSessionJourney();
    const previous = { view: "activity", session: "a", project: "wrong-project", search: "private", result: "success", endpoint: "old-path", layer: "tool", range: "custom", from: "2026-09-01", to: "2026-09-30", service: "Calendar", scope: "all", page: "2" };
    assert.deepEqual(journey.open(previous, "b"), { view: "analyze", session: "b", layer: "tool", range: "custom", from: "2026-09-01", to: "2026-09-30", service: "Calendar", scope: "all" });
    assert.deepEqual(journey.open(previous, "b", "failure"), { ...previous, session: "b", view: "analyze", mode: "calls", request: undefined, page: undefined, result: "failure", origin: undefined });
    assert.deepEqual(journey.open(previous, "b", "success"), { ...previous, session: "b", view: "analyze", mode: "calls", request: undefined, page: undefined, result: "success", origin: undefined });
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

test("return routes allow only existing local state and one bounded source return", () => {
    const journey = createSessionJourney();
    const original = { view: "analyze", mode: "calls", page: 2, authors: "user", search: "legacy private phrase" };
    const nested = { ...original, session: "chat", returnToSessions: { ...original, returnToSessions: original },
        href: "https://elsewhere.invalid", capability: "secret", receipt: { id: "receipt" }, unknown: ["value"] };
    assert.deepEqual(journey.returnRoute(nested, true), { ...original, session: "chat", returnToSessions: original });
    assert.equal(journey.returnRoute({ view: "https://elsewhere.invalid" }), null);
    assert.equal(journey.returnRoute(undefined), null);
});
