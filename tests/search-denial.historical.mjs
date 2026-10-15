import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { rankSearch, rankDiscovery, hasSearchContradiction } from "../lib/search-ranking.mjs";
import { searchDenialEvidence } from "../lib/search-intent.mjs";
import { SEARCH_MODEL_ID } from "../lib/search-model-assets.mjs";
import { SEARCH_INTENT_POLICY_ID } from "../lib/search-linguistics-assets.mjs";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { createLiveSearch } from "../lib/live-search.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { searchWireContract as wire } from "../lib/search-wire-contract.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { originalDocuments, originalExpectations, ordinaryDocuments, ordinaryExpectations,
    rawRequiredPairs, scopeCases, contrastInventories } from "./search-linguistics-fixture.mjs";

const vector = () => {
    const value = new Float32Array(384);
    value[0] = 1;
    return value;
};
const indexed = (content, { title = "", sourceLabel = "", type = "interaction", completeness, hybrid = false } = {}) => {
    const text = [title, content, sourceLabel].filter(Boolean).join("\n");
    return { id: "invented", revision: "1", type, title, content, sourceLabel, text, completeness,
        chunks: hybrid ? [{ start: 0, end: text.length, vector: vector() }] : [] };
};
async function population(query, item, hybrid = false) {
    const chunks = hybrid ? [{ vector: vector() }] : [];
    const signal = new AbortController().signal;
    const strict = await rankSearch([item], query, chunks, [], signal);
    const discovery = await rankDiscovery([item], query, chunks, [], signal);
    assert.deepEqual(discovery.matches, strict);
    return { ids: strict.map(hit => hit.id), discovery };
}

test("complete exact do-support denial cannot supply ordinary strict admission", async () => {
    for (const query of ["repair the car", "archive the memorandum", "inspect a valve", "reconcile an invoice"]) {
        for (const prefix of ["did not", "do not", "does not", "didn't", "don't", "doesn't",
            "I did not", "they didn't", "the technician did not"]) {
            for (const hybrid of [false, true]) {
                const item = indexed(`${prefix} ${query}.`, { completeness: "full", hybrid });
                assert.deepEqual((await population(query, item, hybrid)).ids, [], `${prefix} ${query}; hybrid=${hybrid}`);
            }
        }
    }
});

test("unsupported context and positive evidence retain baseline admission rather than a guessed veto", async () => {
    const query = "repair the car";
    for (const text of [
        "repair the car", "I did repair the car.", "Please repair the car.",
        "I did not repair the car. They did repair the car.",
        "I did not repair the car, but they repaired it.",
        "I did not repair the car and then repaint it.",
        "It is not true that I did not repair the car.",
        "Nobody did not repair the car.",
        "I did not only repair the car.",
        "Did they not repair the car?",
        "I did not repair the car?",
        '"I did not repair the car."',
        "The message says I did not repair the car.",
        "If I did not repair the car, it would fail.",
        "I did not repair the car because it was already repaired.",
        "I did not promise to repair the car.",
        "I did not forget to repair the car.",
        "I did not repair the car without help.",
        "I did not repair the car's engine.",
        "I did not repair the car repair equipment.",
    ]) assert.deepEqual((await population(query, indexed(text, { completeness: "full" }))).ids, ["invented"], text);
    for (const text of ["did not repair the car", "the technician did not repair the car"]) {
        assert.deepEqual((await population("did not repair the car", indexed(text, { completeness: "full" }))).ids, ["invented"]);
    }
});

test("denial evidence cannot replace literal anchors, title/source navigation or other source types", async () => {
    for (const options of [{ title: "repair the car" }, { sourceLabel: "repair the car" }, { type: "report" }]) {
        assert.deepEqual((await population("repair the car", indexed("did not repair the car", { ...options, completeness: "full" }))).ids, ["invented"]);
    }
    assert.deepEqual((await population("GET the report", indexed("did not GET the report", { completeness: "full" }))).ids, ["invented"]);
    assert.deepEqual((await population("GET /me/calendarView 403", indexed("GET /me/calendarView 403", { completeness: "full" }))).ids, ["invented"]);
    assert.deepEqual((await population("POST /me/calendarView 403", indexed("GET /me/calendarView 403", { completeness: "full" }))).ids, []);
    for (const type of ["interaction", "context", "reply"]) {
        assert.deepEqual((await population("repair the car", indexed("did not repair the car",
            { title: "Recorded request", sourceLabel: "Invented conversation", type,
                completeness: type === "reply" ? "full-record" : "full" }))).ids, []);
    }
});

test("a strict denial does not promote or union Related into the strict population", async () => {
    const { ids, discovery } = await population("repair the car", indexed("did not repair the car", { completeness: "full", hybrid: true }), true);
    assert.deepEqual(ids, []);
    assert.deepEqual(discovery.related.map(hit => ({ id: hit.id, match: hit.match })), [{ id: "invented", match: "related" }]);
    assert.equal(discovery.evaluatedItems, 1);
});

test("partial, fragmentary or unknown coverage cannot turn a retained denial into a whole-record veto", async () => {
    for (const type of ["interaction", "context", "reply"]) for (const hybrid of [false, true]) {
        for (const completeness of ["partial", "bounded-fragment", "truncated", "unavailable", "unknown", "", null, undefined]) {
            const item = indexed("did not repair the car", { type, completeness, hybrid });
            assert.deepEqual((await population("repair the car", item, hybrid)).ids, ["invented"], `${type} / ${completeness}`);
        }
        const missing = indexed("did not repair the car", { type, hybrid });
        delete missing.completeness;
        assert.deepEqual((await population("repair the car", missing, hybrid)).ids, ["invented"], `${type} / absent`);
        const wrongType = indexed("did not repair the car",
            { type, completeness: type === "reply" ? "full" : "full-record", hybrid });
        assert.deepEqual((await population("repair the car", wrongType, hybrid)).ids, ["invented"], `${type} / mismatched qualification`);
    }
});

test("finite clause evidence requires the entire exact operation, article and object", () => {
    assert.deepEqual(searchDenialEvidence("Repair the car.", "The technician didn\u2019t repair the car."),
        { state: "contradicted", operation: "repair", article: "the", object: "car" });
    for (const [query, text] of [
        ["repair a car", "did not repair the car"],
        ["repair the car", "did not repair a car"],
        ["repair the car", "did not inspect the car"],
        ["repair the car", "did not repair the van"],
        ["fix my car", "did not repair the automobile"],
        ["repair the car", "did not repair the red car"],
        ["repair the car", "did not repair the car in the garage"],
        ["repair the car", "did not repair the car; repaired it later"],
        ["repair the car", "did not repair the car!"],
        ["repair the car?", "did not repair the car"],
    ]) assert.equal(searchDenialEvidence(query, text).state, "unknown", `${query} / ${text}`);
});

test("the existing semantic ledger receives no new veto; this is not a recall qualification", () => {
    for (const { documents, expectations } of [{ documents: originalDocuments, expectations: originalExpectations },
        { documents: ordinaryDocuments, expectations: ordinaryExpectations }, ...contrastInventories]) {
        for (const { query } of expectations) for (const text of documents) {
            assert.equal(hasSearchContradiction(query, indexed(text, { completeness: "full" })), false, `${query} / ${text}`);
        }
    }
    for (const [query, text] of [...rawRequiredPairs, ...scopeCases.flatMap(group => group.pairs)]) {
        assert.equal(hasSearchContradiction(query, indexed(text, { completeness: "full" })), false, `${query} / ${text}`);
    }
});

function stubSearchChildren(t, mode) {
    const children = [], matches = [];
    class Child extends EventEmitter {
        killed = false;
        constructor(linguistics) { super(); this.linguistics = linguistics; }
        send(message, callback) {
            queueMicrotask(() => {
                if (this.killed) return;
                const stamp = { ok: true, ms: 1, rss: 1024, peakRss: 1024,
                    ...(this.linguistics ? { policyId: SEARCH_INTENT_POLICY_ID } : { modelId: SEARCH_MODEL_ID }) };
                let result;
                if (message.kind === "initialize") {
                    result = !this.linguistics && mode === "lexical-only"
                        ? { ok: false, code: "model-missing" } : { ...stamp, kind: "ready" };
                } else if (message.kind === "embed") {
                    result = { ...stamp, kind: "embedded",
                        chunks: [{ start: 0, end: message.text.length, tokens: 3, vector: vector() }] };
                } else if (message.kind === "prepare") {
                    // Deliberately permissive stubs prove the parent cannot re-add a denial.
                    result = { ...stamp, kind: "prepared", items: message.items.map(item => ({
                        id: item.id, revision: item.revision, intent: {
                            policyId: SEARCH_INTENT_POLICY_ID, state: "supported", characters: item.text.length,
                            polarity: "positive", arguments: [], locations: [],
                            operation: { lemma: "act", pos: "v", start: 0, end: 1,
                                senses: [{ id: "v:00000001", word: 1, lemma: "act" }] },
                        },
                    })) };
                } else {
                    assert.equal(message.kind, "match");
                    matches.push(message.items);
                    result = { ...stamp, kind: "matched", hits: message.items.map(({ id, revision }) => ({ id, revision })) };
                }
                this.emit("message", result);
                callback?.(null);
            });
        }
        kill() {
            if (this.killed) return;
            this.killed = true;
            queueMicrotask(() => this.emit("close", null));
        }
    }
    const mocked = t.mock.method(childProcess, "fork", target => {
        assert.match(String(target), /search-(?:model|linguistics)-worker\.mjs$/);
        const child = new Child(String(target).endsWith("search-linguistics-worker.mjs"));
        children.push(child);
        return child;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    return { children, matches };
}
const record = (id, text, status = "full") => ({
    ...fixture(id), sourceSessionName: "Invented conversation", followUpPrompts: [],
    userPrompt: { text, status, provenance: "human-authored" },
});

test("actual corpus preserves partial-capture words and coverage while vetoing only the full version", async t => {
    const stub = stubSearchChildren(t, "lexical-only");
    const text = "did not repair the car";
    const { context } = await privateFixture(t, [record("full", text, "full"), record("partial", text, "partial")]);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    assert.equal((await engine.build()).mode, "lexical-only");
    let originals, strict, discovery;
    await engine.search({ query: text, requestId: 0, types: ["interaction"] }, hits => { originals = hits; });
    assert.equal(originals.length, 2);
    assert.ok(originals.every(hit => hit.content === text));
    assert.deepEqual(new Set(originals.map(hit => hit.coverage.completeness)), new Set(["full", "partial"]));
    await engine.search({ query: "repair the car", requestId: 1, types: ["interaction"] }, hits => { strict = hits; });
    await engine.discover({ query: "repair the car", requestId: 2, types: ["interaction"] }, result => { discovery = result; });
    assert.deepEqual(discovery.matches.hits, strict);
    assert.deepEqual(strict.map(hit => hit.target.href), ["#request?request=partial"]);
    assert.equal(strict[0].coverage.completeness, "partial");
    assert.equal(strict[0].content, text);
    await engine.close();
    assert.ok(stub.children.every(child => child.killed));
});

test("actual corpus delivery excludes denials even with a permissive optional matcher; sources still revalidate", async t => {
    const stub = stubSearchChildren(t, "hybrid");
    const rows = [record("positive", "repair the car"), record("denied", "did not repair the car"),
        record("partial", "did not repair the car", "partial"),
        record("mixed", "did not repair the car; someone else repaired it")];
    const { context } = await privateFixture(t, rows);
    let source = inventedSource(), invalidations = 0;
    const engine = createSearchRetrieval(context, { source: () => source, linguisticsDirectory: "stub-only-no-assets",
        onInvalidate: () => { invalidations++; } });
    t.after(() => engine.close());
    assert.equal((await engine.build()).mode, "hybrid");
    let strict, discovery;
    await engine.search({ query: "repair the car", requestId: 0, types: ["interaction"] }, hits => { strict = hits; });
    await engine.discover({ query: "repair the car", requestId: 1, types: ["interaction"] }, result => { discovery = result; });
    assert.deepEqual(discovery.matches.hits, strict);
    assert.deepEqual(new Set(strict.map(hit => hit.target.href)),
        new Set(["#request?request=positive", "#request?request=mixed", "#request?request=partial"]));
    assert.ok(strict.every(hit => /^wire-search-v1:interaction:[a-f0-9]{64}$/.test(hit.id) && /^[a-f0-9]{64}$/.test(hit.revision)));
    assert.deepEqual(discovery.related.hits.map(hit => hit.target.href), ["#request?request=denied"]);
    const deniedId = discovery.related.hits[0].id;
    assert.ok(stub.matches.length === 2 && stub.matches.every(items => items.length === 3
        && items.every(item => item.id !== deniedId) && items.some(item => item.text === "did not repair the car")));
    source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    const stale = await engine.search({ query: "repair the car", requestId: 2 }, () => assert.fail("Changed source disclosed"));
    assert.equal(stale.state, "stale");
    assert.ok(invalidations > 0);
    await engine.close();
    assert.ok(stub.children.every(child => child.killed));
});

test("actual wire receipts carry the complete corrected population into both periods and in-memory report scope", async t => {
    const stub = stubSearchChildren(t, "lexical-only");
    const rows = Array.from({ length: 63 }, (_, i) => record(`positive-${i}`, "repair the car"));
    rows.push(record("denied", "The technician did not repair the car."));
    const { context } = await privateFixture(t, rows);
    await seedRetainedReply(context, inventedSource(), "did not repair the car");
    const collector = await createCollector(context, { timers: false });
    t.mock.method(collector, "assessmentSource", inventedSource);
    const live = createLiveSearch(context, { heartbeatMs: 60000 });
    t.after(async () => { await live.close(); await collector.close(); });
    const events = [];
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        writeHead() {}, flushHeaders() {}, write(line) { events.push(JSON.parse(line)); }, end() { this.emit("close"); } });
    live.attach("denial-proof", response, { schemaVersion: 2 });
    live.query("denial-proof", { schemaVersion: 2, purpose: "analysis", query: "repair the car", requestId: 0 });
    const deadline = AbortSignal.timeout(10000);
    while (!events.some(event => event.event === "results")) {
        deadline.throwIfAborted();
        await setImmediate();
    }
    const event = events.find(value => value.event === "results"), stamp = event.matches.receipt;
    assert.equal(wire.validResults(event), true);
    assert.equal(event.status.model.code, "model-missing");
    assert.equal(stamp.mode, "lexical-only");
    assert.equal(event.matches.total, 64);
    assert.equal(new Set(event.matches.hits.map(hit => hit.id)).size, 64);
    const reply = event.matches.hits.find(hit => hit.type === "reply");
    assert.equal(reply.coverage.completeness, "bounded-fragment");
    assert.equal(reply.excerpt, "Retained Copilot reply\ndid not repair the car\nLocally retained Copilot reply");
    const state = await loadBoardState(context);
    const selected = live.membership("denial-proof", stamp, state, "tool");
    assert.deepEqual(new Set(selected.scenarioIds), new Set(rows.slice(0, 63).map(row => row.scenarioId)));
    assert.deepEqual(selected.actionIds, []);
    for (let page = 0; page < 4; page++) {
        assert.equal(event.matches.hits.slice(page * 20, (page + 1) * 20).length, page === 3 ? 4 : 20);
        assert.equal(live.membership("denial-proof", stamp, state, "tool").scenarioIds.length, 63);
    }
    const input = { schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-09-30", to: "2026-10-01" } },
        semanticSelection: { receipt: stamp }, withinServices: [] };
    const comparison = buildPeriodComparison(state, input, { semanticMembership: selected });
    for (const side of Object.values(comparison.periods)) assert.deepEqual(new Set(side.scenarioIds), new Set(selected.scenarioIds));
    const accepted = acceptPeriodReport(state, comparison, { semanticSelection: input.semanticSelection,
        resolveSemantic: () => live.membership("denial-proof", stamp, state, "tool") });
    const frozen = freezePeriodReport(state, accepted, "2026-10-15T05:30:00.000Z").frozen;
    for (const side of Object.values(frozen.periods)) {
        assert.equal(side.rows.length, 63);
        assert.deepEqual(side.scenarioRefs, frozen.selection.semanticMembership.scenarioRefs);
    }
    live.cancel("denial-proof");
    assert.throws(() => live.membership("denial-proof", stamp, state, "tool"), /stale-search-membership/);
    await live.close();
    assert.deepEqual(live.status(), { panels: 0, closing: 0, maxPanels: 2 });
    assert.ok(stub.children.every(child => child.killed));
});
