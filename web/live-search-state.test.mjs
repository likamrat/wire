import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSearchState } from "./live-search-state.mjs";
import { searchWireContract as wire } from "../lib/search-wire-contract.mjs";

const panelId = "11111111-1111-4111-8111-111111111111";
const frame = (event, extra = {}) => ({ schemaVersion: 2, panelId, epoch: 0, event, ...extra });
function results(requestId, purpose = "navigation") {
    const base = { schemaVersion: 2, panelId, epoch: 0, requestId, generation: 1, revision: 1,
        modelId: "a".repeat(64), indexId: "b".repeat(64), mode: "hybrid", queryPurpose: purpose, queryTypes: [...wire.allTypes] };
    const hit = id => ({ id, revision: "c".repeat(64), type: "interaction", excerpt: "Invented", match: "exact" });
    return frame("results", { purpose, requestId,
        matches: { hits: [hit("matched")], total: 1, receipt: { ...base, purpose: "strict-match-population", matchPolicyId: wire.matchPolicyId } },
        ...(purpose === "navigation" ? { related: { hits: [{ ...hit("related"), match: "related", purpose: "navigate-only" }], total: 1,
            receipt: { ...base, purpose: "related-navigation", relatedPolicyId: wire.relatedPolicyId },
            coverage: { populationComplete: false, corpusState: "ready", evaluatedItems: 2, retrieval: "policy-selected-candidates" } } } : {}),
        status: { mode: "hybrid", indexId: base.indexId, modelId: base.modelId, corpus: { state: "ready", generation: 1 } },
    });
}

test("new query and current unavailable status erase both sets, never merging navigation into analysis", () => {
    const state = createLiveSearchState(wire);
    state.receive(frame("connected"));
    state.query(1, "navigation", []);
    state.receive(results(1));
    assert.equal(state.snapshot().matches.hits.length, 1);
    assert.equal(state.snapshot().related.hits.length, 1);
    state.query(2, "analysis", []);
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(state.snapshot().related, null);
    state.receive(results(1));
    assert.deepEqual(state.snapshot().matches.hits, []);
    state.receive(frame("status", { requestId: 1, state: "no-match" }));
    assert.equal(state.snapshot().state, "queued");
    state.receive(frame("status", { requestId: 2, state: "building" }));
    assert.equal(state.snapshot().state, "building");
    state.receive(results(2, "analysis"));
    assert.equal(state.snapshot().related, null);
    state.receive(frame("status", { requestId: 2, state: "unavailable" }));
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(state.snapshot().matches.receipt, null);
});

test("fences and reconnect erase both maps and reject prior-generation resurrection", () => {
    const state = createLiveSearchState(wire);
    state.receive(frame("connected"));
    state.query(1, "navigation", []);
    state.receive(results(1));
    state.receive(frame("fence", { epoch: 1, reason: "changed" }));
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(state.snapshot().related, null);
    state.receive(results(1));
    assert.deepEqual(state.snapshot().matches.hits, []);
    state.disconnect();
    state.receive(frame("connected", { panelId: "22222222-2222-4222-8222-222222222222" }));
    state.receive(results(1));
    assert.deepEqual(state.snapshot().matches.hits, []);
    assert.equal(state.snapshot().related, null);
});

test("v1, overlapping or purpose/type-forged current result frames fail closed", () => {
    for (const alter of [
        value => { delete value.schemaVersion; },
        value => { value.purpose = "analysis"; },
        value => { value.matches.receipt.queryTypes = ["action"]; },
        value => { value.related.hits[0].id = value.matches.hits[0].id; },
        value => { value.related.receipt.relatedPolicyId = "d".repeat(64); },
        value => { delete value.requestId; },
    ]) {
        const state = createLiveSearchState(wire);
        state.receive(frame("connected")); state.query(1, "navigation", []);
        state.receive(results(1));
        const malformed = results(1); alter(malformed);
        assert.throws(() => state.receive(malformed), /Search.*changed|Search.*invalid/);
        assert.equal(state.snapshot().related, null);
        assert.deepEqual(state.snapshot().matches.hits, []);
    }
});
