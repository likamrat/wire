import test from "node:test";
import assert from "node:assert/strict";
import { createChatCopy } from "../lib/chat-copy.mjs";

const copy = createChatCopy();
function originalReference(sessions, scenarios, source, recorder = false) {
    if (!source) return null;
    const sources = new Map((sessions || []).map(item => [item.sessionId, item.name]));
    for (const item of scenarios || []) if (item.sourceSessionId && !sources.has(item.sourceSessionId)) {
        sources.set(item.sourceSessionId, item.sourceSessionName || copy.unnamed);
    }
    if (source.name !== copy.unnamed && ![...sources].some(([id, name]) => id !== source.sessionId && name === source.name)) return null;
    let length = Math.min(8, source.sessionId.length);
    while (length < source.sessionId.length && [...sources.keys()].some(id => id !== source.sessionId && id.endsWith(source.sessionId.slice(-length)))) length++;
    return `${recorder ? "Source" : "Chat"} ${length < source.sessionId.length ? "..." : ""}${source.sessionId.slice(-length)}`;
}
const outcome = action => {
    try { return { value: action() }; }
    catch (error) { return { error: error.name }; }
};

test("source references preserve exact names, aliases, absent IDs and shortest suffixes", () => {
    const sessions = [
        { sessionId: "unique-source", name: "Unique" },
        { sessionId: "prefix-a12345678", name: "Repeated" },
        { sessionId: "prefix-b12345678", name: "Repeated" },
        { sessionId: "short", name: "Repeated" },
        { sessionId: "12345678", name: "Repeated" },
        { sessionId: "unnamed-source", name: copy.unnamed },
        { sessionId: "empty-name", name: "" },
        { sessionId: "empty-name-two", name: "" },
        { sessionId: "alias", name: "Old name" },
        { sessionId: "alias", name: "Current name" },
    ];
    const scenarios = [
        { sourceSessionId: "alias", sourceSessionName: "Must not override metadata" },
        { sourceSessionId: "fallback-source", sourceSessionName: null },
        { sourceSessionId: "fallback-named", sourceSessionName: "Repeated" },
        { sourceSessionId: "fallback-named", sourceSessionName: "First scenario wins" },
        { sourceSessionId: null, sourceSessionName: "Not admitted" },
    ];
    const queries = [...sessions, ...scenarios.map(s => ({ sessionId: s.sourceSessionId, name: s.sourceSessionName || copy.unnamed })),
        { sessionId: "absent-c12345678", name: "Repeated" },
        { sessionId: "not-in-catalog", name: "Unique" },
        { sessionId: "", name: copy.unnamed }, {}, null, undefined];
    for (const factory of [createChatCopy, Function(`return (${createChatCopy.toString()})`)()]) {
        const references = factory().references(sessions, scenarios);
        for (const query of queries) for (const recorder of [false, true]) {
            assert.deepEqual(outcome(() => references(query, recorder)), outcome(() => originalReference(sessions, scenarios, query, recorder)));
        }
        assert.equal(references(sessions[0]), null);
        assert.equal(references(sessions[1]), "Chat ...a12345678");
        assert.equal(references(sessions[2], true), "Source ...b12345678");
        assert.equal(references(sessions[3]), "Chat short");
        assert.equal(references(sessions[4]), "Chat 12345678");
        assert.equal(references({ sessionId: "fallback-source", name: copy.unnamed }), "Chat ...k-source");
    }
});

test("duplicate-heavy suffix collisions agree with the original for catalog and absent queries", () => {
    const names = [copy.unnamed, "", "Repeated", "Case", "case"];
    const ids = ["", "a", "1234567", "12345678", "a12345678", "ba12345678", "ca12345678",
        "same-\u00e9", "other-\u00e9", "prefix-\ud83d\ude00tail"];
    for (let i = 0; i < 180; i++) ids.push(`prefix-${i}-shared-ending`);
    const sessions = ids.map((sessionId, i) => ({ sessionId, name: names[i % names.length] }));
    const references = copy.references(sessions, []);
    for (const source of [...sessions, ...ids.map((id, i) => ({ sessionId: "absent-" + id, name: names[i % names.length] }))]) {
        assert.deepEqual(outcome(() => references(source)), outcome(() => originalReference(sessions, [], source)), source.sessionId);
    }
});

test("malformed or missing identities retain the original failure behavior, not invented labels", () => {
    const sessions = [{ sessionId: undefined, name: "Repeated" }, { sessionId: null, name: "Repeated" },
        { sessionId: "valid-long-source", name: "Repeated" }, { sessionId: NaN, name: "Number" }, { sessionId: 7, name: NaN }];
    const references = copy.references(sessions, []);
    for (const source of [...sessions, {}, { name: "Unique" }, { sessionId: "other-long-source", name: copy.unnamed }, null]) {
        assert.deepEqual(outcome(() => references(source)), outcome(() => originalReference(sessions, [], source)));
    }
});

test("a render lookup reads the catalog once and a later lookup observes source changes", () => {
    let reads = 0;
    const sessions = Array.from({ length: 4000 }, (_, i) => ({
        sessionId: `source-${i}-shared-ending`,
        get name() { reads++; return "Repeated"; },
    }));
    const references = copy.references(sessions, []);
    assert.equal(reads, 4000);
    for (const session of sessions) assert.ok(references({ sessionId: session.sessionId, name: "Repeated" }).startsWith("Chat "));
    assert.equal(reads, 4000, "Looking up options must not rebuild the source-name catalog");
    const changed = copy.references([{ sessionId: "source-0-shared-ending", name: "Renamed" }], []);
    assert.equal(changed({ sessionId: "source-0-shared-ending", name: "Renamed" }), null);
    assert.equal(copy.references([], [])({ sessionId: "source-0-shared-ending", name: "Repeated" }), null);
});
