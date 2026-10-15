import test from "node:test";
import assert from "node:assert/strict";
import { originalDocuments, originalExpectations, ordinaryDocuments, ordinaryExpectations,
    rawRequiredPairs, scopeCases, contrastInventories, assertSearchPopulation } from "./search-linguistics-fixture.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { loadBoardState, mergeEvidenceWithState } from "../lib/store.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createLiveSearchState } from "../web/live-search-state.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { searchWireContract as wire } from "../lib/search-wire-contract.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";

test("canonical search bounds preserve every MUST and ALLOWED without inventing contrast recall", () => {
    const groups = [{ documents: originalDocuments, expectations: originalExpectations },
        { documents: ordinaryDocuments, expectations: ordinaryExpectations }, ...contrastInventories];
    for (const { documents, expectations } of groups) {
        assert.equal(new Set(expectations.map(item => item.query)).size, expectations.length);
        for (const item of expectations) {
            assert.equal(new Set(item.allowed).size, item.allowed.length);
            assert.ok(item.allowed.every(id => Number.isInteger(id) && id >= 0 && id < documents.length));
            if (item.must !== null) assert.ok(item.must.every(id => item.allowed.includes(id)));
        }
    }
    assert.equal(originalExpectations.length, 16);
    assert.equal(ordinaryExpectations.length, 12);
    assert.equal(contrastInventories.flatMap(group => group.expectations).length, 18);
    assert.equal(contrastInventories.flatMap(group => group.expectations).filter(item => item.must === null).length, 9);
    for (const item of originalExpectations.slice(0, 3)) {
        assert.deepEqual(item.must, [1]); assert.deepEqual(item.allowed, [1, 3]);
        assert.doesNotThrow(() => assertSearchPopulation([1], item));
        assert.doesNotThrow(() => assertSearchPopulation([3, 1], item));
        for (const actual of [[], [3], [1, 2], [1, 1]]) assert.throws(() => assertSearchPopulation(actual, item));
    }
    for (const item of contrastInventories.flatMap(group => group.expectations).filter(item => item.must === null)) {
        assert.throws(() => assertSearchPopulation([], item), /Unspecified recall/);
    }
});

test("scope authority separates genuine negatives from unspecified mechanism abstention", () => {
    assert.equal(scopeCases.flatMap(group => group.pairs).length, 11, "Do not drop mechanism coverage.");
    const negatives = scopeCases.filter(group => group.authority === "primary-negative-contrast");
    const observations = scopeCases.filter(group => group.authority === "mechanism-observation");
    assert.equal(negatives.flatMap(group => group.pairs).length, 4);
    assert.equal(observations.flatMap(group => group.pairs).length, 7);
    for (const group of negatives) {
        assert.deepEqual(group.must, []); assert.deepEqual(group.allowed, []);
        assert.doesNotThrow(() => assertSearchPopulation([], { ...group, query: group.meaning }));
        assert.throws(() => assertSearchPopulation([0], { ...group, query: group.meaning }), /Forbidden/);
    }
    for (const group of observations) {
        assert.equal(group.must, null); assert.equal(group.allowed, null);
        for (const [query] of group.pairs) for (const actual of [[], [0]]) {
            assert.throws(() => assertSearchPopulation(actual, { ...group, query }), /Unspecified recall/);
        }
    }
    for (const pair of rawRequiredPairs) {
        assert.ok(!negatives.flatMap(group => group.pairs).some(rejected => JSON.stringify(rejected) === JSON.stringify(pair)),
            "Required positive is also forbidden: " + pair[0]);
    }
});

test("consumer contract: MUST/ALLOWED survives Matches, analysis, both periods and frozen report scope without Related union", async t => {
    const records = originalDocuments.map((text, index) => {
        const row = fixture(`search-${index}`);
        row.userPrompt.text = text; row.followUpPrompts = [];
        row.toolCalls[0].startedAt = row.capturedAt;
        return row;
    });
    const { context } = await privateFixture(t, records);
    const state = await loadBoardState(context), scenarios = mergeEvidenceWithState(state);
    const snapshot = { revision: state.revision, scenarios, requestActivity: buildRequestActivity(scenarios) };
    const indices = ids => ids.map(id => Number(id.split("-").at(-1)));
    const hit = index => ({ id: `hit-${index}`, revision: "c".repeat(64), type: "interaction",
        excerpt: originalDocuments[index], match: "semantic", target: { kind: "route", href: `#request?request=search-${index}` } });
    const base = { schemaVersion: 2, panelId: "11111111-1111-4111-8111-111111111111", epoch: 0,
        requestId: 1, generation: 1, revision: state.revision, modelId: "a".repeat(64), indexId: "b".repeat(64),
        mode: "hybrid", queryTypes: [...wire.allTypes] };
    // Fabricated admitted sets test consumers, never model relevance or actual recall.
    for (const population of [[1], [1, 3]]) {
        const matches = population.map(hit), contract = originalExpectations[0];
        const relatedHit = { ...hit(0), match: "related", purpose: "navigate-only" };
        const navigationReceipt = { ...base, purpose: "strict-match-population", queryPurpose: "navigation", matchPolicyId: wire.matchPolicyId };
        const navigation = { schemaVersion: 2, event: "results", panelId: base.panelId, epoch: 0, requestId: 1, purpose: "navigation",
            matches: { hits: matches, total: matches.length, receipt: navigationReceipt },
            related: { hits: [relatedHit], total: 1,
                receipt: { ...base, purpose: "related-navigation", queryPurpose: "navigation", relatedPolicyId: wire.relatedPolicyId },
                coverage: { populationComplete: false, corpusState: "ready", evaluatedItems: 9, retrieval: "policy-selected-candidates" } },
            status: { mode: "hybrid", indexId: base.indexId, modelId: base.modelId, corpus: { state: "ready", generation: 1 } } };
        assert.equal(wire.validResults(navigation), true);
        const client = createLiveSearchState(wire);
        client.receive({ schemaVersion: 2, event: "connected", panelId: base.panelId, epoch: 0 });
        client.query(1, "navigation", []); client.receive(navigation);
        assertSearchPopulation(indices(client.snapshot().matches.hits.map(item => item.id)), contract);
        assert.throws(() => assertSearchPopulation(indices([...matches, relatedHit].map(item => item.id)), contract), /Forbidden/);
        const stamp = { ...navigationReceipt, requestId: 2, queryPurpose: "analysis" };
        assert.throws(() => createSearchMembership(snapshot, { layer: "tool" }, [], matches, navigationReceipt, wire));
        assert.throws(() => createSearchMembership(snapshot, { layer: "tool" }, [], [...matches, relatedHit], stamp, wire));
        const analysis = { ...navigation, requestId: 2, purpose: "analysis", matches: { ...navigation.matches, receipt: stamp } };
        delete analysis.related;
        client.query(2, "analysis", []); client.receive(analysis);
        assert.deepEqual(client.snapshot().matches.hits, matches);
        const selected = createSearchMembership(snapshot, { layer: "tool" }, [], client.snapshot().matches.hits, stamp, wire);
        assertSearchPopulation(indices(selected.scenarioIds), contract);
        const membership = { scenarioIds: selected.scenarioIds, actionIds: selected.actionIds, parentScenarioIds: selected.parentScenarioIds };
        const input = { schemaVersion: 1, expectedRevision: state.revision,
            options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
            periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-09-30", to: "2026-10-01" } },
            semanticSelection: { receipt: stamp }, withinServices: [] };
        const comparison = buildPeriodComparison(state, input, { semanticMembership: membership });
        for (const side of Object.values(comparison.periods)) {
            assertSearchPopulation(indices(side.scenarioIds), contract);
            assert.deepEqual(side.scenarioIds, selected.scenarioIds);
        }
        const accepted = acceptPeriodReport(state, comparison, { semanticSelection: input.semanticSelection, resolveSemantic: () => membership });
        const frozen = freezePeriodReport(state, accepted, "2026-10-12T12:00:00.000Z").frozen;
        for (const side of Object.values(frozen.periods)) {
            assert.deepEqual(side.scenarioRefs, frozen.selection.semanticMembership.scenarioRefs);
            assert.equal(side.rows.length, population.length);
        }
    }
});
