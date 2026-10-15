import test from "node:test";
import assert from "node:assert/strict";
import { searchFixture, searchRecords, streamPanel } from "./live-search-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createSearchWireContract, searchWireContract } from "../lib/search-wire-contract.mjs";
import { SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_LEXICAL_POLICIES, SEARCH_TYPES } from "../lib/search-ranking.mjs";

const directory = process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY;
const modelDirectory = process.env.WIRE_SEARCH_MODEL_TEST_DIRECTORY;
test("opt-in live lexical results retain purpose, complete period membership and report-preview authority", { skip: !directory, timeout: 120000 }, async t => {
    const records = searchRecords(4);
    for (const index of [0, 1]) {
        records[index].userPrompt.text = "The mechanic repaired a broken automobile in the garage.";
        records[index].capturedAt = index ? "2026-09-30T12:00:00.000Z" : "2026-09-29T12:00:00.000Z";
        records[index].toolCalls[0].startedAt = records[index].capturedAt;
        records[index].httpRecords[0].startedAt = records[index].capturedAt;
    }
    const app = await searchFixture(t, { records, search: { modelDirectory, linguisticsDirectory: directory } });
    const panel = await streamPanel(app.runtime, { purpose: "navigation" });
    t.after(() => panel.close());
    const before = await loadBoardState(app.context);
    assert.equal((await panel.api("/api/search/query", { query: "fix my car", requestId: 0 })).code, 200);
    const navigation = await panel.wait(event => event.event === "results" && event.requestId === 0);
    assert.equal(searchWireContract.validResults(navigation), true);
    assert.equal(navigation.matches.receipt.matchPolicyId, SEARCH_LEXICAL_POLICIES.matchPolicyId);
    assert.equal(navigation.related.receipt.relatedPolicyId, SEARCH_LEXICAL_POLICIES.relatedPolicyId);
    const serialized = new Function("return (" + createSearchWireContract.toString() + ")")();
    const browserContract = serialized({ matchPolicyId: SEARCH_MATCH_POLICY_ID, relatedPolicyId: SEARCH_RELATED.id,
        types: SEARCH_TYPES, lexicalPolicies: SEARCH_LEXICAL_POLICIES });
    assert.equal(browserContract.validResults(navigation), true);
    const mismatched = structuredClone(navigation);
    mismatched.related.receipt.relatedPolicyId = SEARCH_RELATED.id;
    assert.equal(browserContract.validResults(mismatched), false);
    assert.equal(navigation.matches.total, 2);
    assert.ok(navigation.related.hits.every(hit => !navigation.matches.hits.some(match => match.id === hit.id)));
    const input = receipt => ({
        schemaVersion: 1, expectedRevision: before.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-29", to: "2026-09-29" }, later: { from: "2026-09-30", to: "2026-09-30" } },
        semanticSelection: { receipt }, withinServices: [],
    });
    assert.equal((await panel.api("/api/period-comparison", input(navigation.matches.receipt))).code, 422);
    await panel.api("/api/search/query", { query: "fix my car", requestId: 1, purpose: "analysis" });
    const analysis = await panel.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(searchWireContract.validResults(analysis), true);
    assert.equal(Object.hasOwn(analysis, "related"), false);
    assert.equal(analysis.matches.total, 2);
    for (const matchPolicyId of [SEARCH_MATCH_POLICY_ID, "0".repeat(64)]) {
        assert.ok([409, 422].includes((await panel.api("/api/period-comparison",
            input({ ...analysis.matches.receipt, matchPolicyId }))).code));
    }
    const pair = await panel.api("/api/period-comparison", input(analysis.matches.receipt));
    assert.equal(pair.code, 200, pair.body.error);
    assert.deepEqual(pair.body.periods.baseline.scenarioIds, ["search-0"]);
    assert.deepEqual(pair.body.periods.later.scenarioIds, ["search-1"]);
    const preview = await panel.api("/api/preview", {
        periodComparison: pair.body, semanticSelection: { receipt: analysis.matches.receipt },
        options: { promptMode: "none", formats: ["json"], timeContext: pair.body.timeContext },
    });
    assert.equal(preview.code, 200, preview.body.error);
    assert.equal(preview.body.snapshot.periodComparison.periods.baseline.rows.length, 1);
    assert.equal(preview.body.snapshot.periodComparison.periods.later.rows.length, 1);
    await panel.api("/api/cancel-preview", { previewId: preview.body.previewId });
    await panel.api("/api/search/query", { query: "", requestId: 2, purpose: "analysis" });
    assert.equal((await panel.api("/api/period-comparison", input(analysis.matches.receipt))).code, 409);
    const after = await loadBoardState(app.context);
    for (const key of ["evidence", "cards", "personalEvaluation", "exports"]) assert.deepEqual(after[key], before[key]);
});
