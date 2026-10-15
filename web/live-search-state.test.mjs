import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSearchState } from "./live-search-state.mjs";
import { searchWireContract as wire } from "../lib/search-wire-contract.mjs";

const panelId = "11111111-1111-4111-8111-111111111111";
const frame = (event, extra = {}) => ({ schemaVersion: wire.schemaVersion, panelId, epoch: 0, event, ...extra });
function results(requestId, purpose = "navigation") {
    const base = { schemaVersion: wire.schemaVersion, panelId, epoch: 0, requestId, generation: 1, revision: 1,
        indexId: "b".repeat(64), mode: "text", queryPurpose: purpose, queryTypes: [...wire.allTypes] };
    const hit = id => ({ id, revision: "c".repeat(64), type: "interaction", title: "Recorded request",
        excerpt: "PowerPoint", source: { label: "Invented chat" }, target: { kind: "route", href: "#request?request=invented" },
        match: "text", textMatch: { field: "content", start: 0, end: 5, excerptStart: 0 } });
    return frame("results", { purpose, requestId,
        matches: { hits: [hit("matched")], total: 1, receipt: { ...base, purpose: "strict-match-population", matchPolicyId: wire.matchPolicyId } },
        status: { mode: "text", indexId: base.indexId, corpus: { state: "ready", generation: 1 } },
    });
}

test("new query and unavailable status erase the sole literal result population", () => {
    const state = createLiveSearchState(wire);
    state.receive(frame("connected"));
    state.query(1, "navigation", []);
    state.receive(results(1));
    assert.equal(state.snapshot().matches.hits.length, 1);
    assert.equal(Object.hasOwn(state.snapshot(), "related"), false);
    state.query(2, "analysis", []);
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(Object.hasOwn(state.snapshot(), "related"), false);
    state.receive(results(1));
    assert.deepEqual(state.snapshot().matches.hits, []);
    state.receive(frame("status", { requestId: 1, state: "no-match" }));
    assert.equal(state.snapshot().state, "queued");
    state.receive(frame("status", { requestId: 2, state: "building" }));
    assert.equal(state.snapshot().state, "building");
    state.receive(results(2, "analysis"));
    assert.equal(Object.hasOwn(state.snapshot(), "related"), false);
    state.receive(frame("status", { requestId: 2, state: "unavailable" }));
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(state.snapshot().matches.receipt, null);
});

test("fences and reconnect erase literal results and reject prior-generation resurrection", () => {
    const state = createLiveSearchState(wire);
    state.receive(frame("connected"));
    state.query(1, "navigation", []);
    state.receive(results(1));
    state.receive(frame("fence", { epoch: 1, reason: "changed" }));
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(Object.hasOwn(state.snapshot(), "related"), false);
    state.receive(results(1));
    assert.deepEqual(state.snapshot().matches.hits, []);
    state.disconnect();
    state.receive(frame("connected", { panelId: "22222222-2222-4222-8222-222222222222" }));
    state.receive(results(1));
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(Object.hasOwn(state.snapshot(), "related"), false);
});

test("obsolete protocols, Related and forged current purpose/type/match frames fail closed", () => {
    for (const alter of [
        value => { delete value.schemaVersion; },
        value => { value.schemaVersion = 2; },
        value => { value.purpose = "analysis"; },
        value => { value.matches.receipt.queryTypes = ["action"]; },
        value => { value.related = {}; },
        value => { value.matches.hits[0].match = "semantic"; },
        value => { value.matches.receipt.mode = "hybrid"; },
        value => { delete value.requestId; },
    ]) {
        const state = createLiveSearchState(wire);
        state.receive(frame("connected")); state.query(1, "navigation", []);
        state.receive(results(1));
        const malformed = results(1); alter(malformed);
        assert.throws(() => state.receive(malformed), /Search.*changed|Search.*invalid/);
        assert.equal(Object.hasOwn(state.snapshot(), "related"), false);
        assert.deepEqual(state.snapshot().matches.hits, []);
    }
});

test("zero matches with unavailable requested content is incomplete, not a no-match conclusion", () => {
    const state = createLiveSearchState(wire);
    state.receive(frame("connected"));
    state.query(1, "analysis", []);
    const value = results(1, "analysis");
    value.matches.hits = []; value.matches.total = 0;
    value.status.corpus = { state: "partial", generation: 1, issues: [{ code: "read-failed", types: ["reply"] }] };
    state.receive(value);
    assert.equal(state.snapshot().state, "incomplete");
});
