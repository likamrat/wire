import test from "node:test";
import assert from "node:assert/strict";
import { createSessionJourney } from "./session-journey.mjs";

test("interaction sidebar keeps its sanitized origin or a safe Analyze deep-link scope", () => {
    const journey = createSessionJourney();
    const origin = { view: "analyze", page: "2", authors: "user", search: "invented query" };
    assert.deepEqual(journey.underlying({ view: "request", request: "a", returnToResults: origin }), origin);
    assert.deepEqual(journey.underlying({ view: "request", request: "a", call: "b", layer: "tool", service: "Files" }),
        { view: "analyze", layer: "tool", service: "Files" });
    assert.deepEqual(journey.underlying({ view: "request", request: "a", returnToResults: { view: "reports", task: "create", receipt: "forbidden" } }),
        { view: "reports", task: "create" });
    assert.equal(journey.underlying(origin), origin);
});

test("Analyze aliases keep the exact filter, private query and paging state", () => {
    const journey = createSessionJourney();
    const scope = { services: "Files", includeMissingService: false, authors: "user", result: "failure",
        session: "invented-chat", page: "2", search: "private phrase", localSearch: { settingsSearch: "display" } };
    for (const view of ["analyze", "home", "overview", "activity"]) {
        assert.deepEqual(journey.canonical({ ...scope, view }), { ...scope, view: "analyze" });
    }
    const { page, ...withoutCallPage } = scope;
    for (const legacy of [{ view: "calls" }, { view: "analyze", mode: "calls", callSort: "fastest" }]) {
        assert.deepEqual(journey.canonical({ ...scope, ...legacy }), { ...withoutCallPage, view: "analyze" });
    }
    assert.deepEqual(journey.canonical({ ...scope, view: "request", request: "invented-request" }),
        { ...scope, view: "request", request: "invented-request" });
});

test("chat context and result links stay in unified Analyze", () => {
    const journey = createSessionJourney();
    const previous = { view: "activity", session: "a", project: "wrong-project", search: "private", result: "success", endpoint: "old-path", layer: "tool", range: "custom", from: "2026-09-01", to: "2026-09-30", service: "Calendar", scope: "all", page: "2" };
    assert.deepEqual(journey.open(previous, "b"), { view: "analyze", session: "b", layer: "tool", range: "custom", from: "2026-09-01", to: "2026-09-30", service: "Calendar", scope: "all" });
    assert.deepEqual(journey.open(previous, "b", "failure"), { ...previous, session: "b", view: "analyze", request: undefined, page: undefined, result: "failure", origin: undefined });
    assert.deepEqual(journey.open(previous, "b", "success"), { ...previous, session: "b", view: "analyze", request: undefined, page: undefined, result: "success", origin: undefined });
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
    const adapted = { view: "analyze", authors: "user", search: "legacy private phrase" };
    assert.deepEqual(journey.returnRoute(nested, true), { ...adapted, session: "chat", returnToSessions: adapted });
    assert.equal(journey.returnRoute({ view: "https://elsewhere.invalid" }), null);
    assert.equal(journey.returnRoute(undefined), null);
});

test("saved workspace routes accept only artifact identities and bounded library state", () => {
    const journey = createSessionJourney();
    const id = "export-11111111-2222-4333-8444-555555555555";
    assert.deepEqual(journey.savedRoute({ view: "reports", bundle: id, inspect: id, task: "create", order: "oldest" }),
        { view: "reports", bundle: id, order: "oldest" });
    assert.deepEqual(journey.savedRoute({ view: "reports", inspect: id, order: "oldest" }),
        { view: "reports", inspect: id, order: "oldest" });
    assert.deepEqual(journey.savedRoute({ view: "reports", bundle: "private text", inspect: "https://example.invalid", order: "anything" }),
        { view: "reports" });
    assert.deepEqual(journey.savedRoute({ view: "analyze", bundle: id, inspect: id, order: "oldest" }), { view: "analyze" });
    assert.deepEqual(journey.returnRoute({ view: "reports", inspect: id, order: "oldest", localSearch: { savedReportSearch: "private" }, receipt: "secret" }),
        { view: "reports", inspect: id, order: "oldest", localSearch: { savedReportSearch: "private" } });
});

test("saved document origins preserve one sanitized interaction and exact-call return without authority", () => {
    const journey = createSessionJourney();
    assert.deepEqual(journey.savedOrigin({ view: "request", request: "interaction-a", call: "call-a", callRevision: "7",
        origin: "reports", receipt: "not-return-state", html: "not-return-state", savedAuthority: "search",
        returnToResults: { view: "reports", task: "create", localSearch: { reportRequestSearch: "private query" },
            receipt: "not-return-state", returnToResults: { view: "request", request: "nested" } } }),
    { view: "request", origin: "reports", request: "interaction-a", call: "call-a", callRevision: "7",
        returnToResults: { view: "reports", task: "create", localSearch: { reportRequestSearch: "private query" } } });
    assert.equal(journey.savedOrigin({ view: "request", request: "" }), null);
    assert.equal(journey.savedOrigin(null), null);
});
