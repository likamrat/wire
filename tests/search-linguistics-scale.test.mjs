import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { createSearchLinguistics } from "../lib/search-linguistics.mjs";
import { searchHash } from "../lib/search-model-assets.mjs";
import { SEARCH_LEXICAL_POLICIES } from "../lib/search-ranking.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { loadBoardState, mergeEvidenceWithState } from "../lib/store.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { inventedSource } from "./search-corpus-fixture.mjs";
import { repetitiveText, variedText } from "./search-linguistics-fixture.mjs";

const directory = process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY;
const modelDirectory = process.env.WIRE_SEARCH_MODEL_TEST_DIRECTORY;
const enabled = { skip: !directory, timeout: 180000 };
const repair = "The mechanic repaired a broken automobile in the garage.";
function rows() {
    const result = Array.from({ length: 63 }, (_, index) => {
        const row = fixture(`search-${index}`);
        row.sourceSessionName = `Invented local conversation ${index}`;
        row.userPrompt.text = repair;
        row.followUpPrompts = [{ text: "Arrange a subsequent medical appointment.", status: "full", provenance: "human-authored" }];
        row.capturedAt = index < 32 ? "2026-09-29T12:00:00.000Z" : "2026-09-30T12:00:00.000Z";
        row.toolCalls[0].startedAt = row.capturedAt;
        row.httpRecords = [{ recordId: `http-${index}`, classification: "direct-graph-http", synthetic: false,
            observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", method: "GET", apiVersion: "v1.0",
            responsePath: { path: "/me/calendarView", query: [] }, startedAt: row.capturedAt,
            durationMs: 12, status: index === 0 ? 403 : 200, transportError: null }];
        return row;
    });
    for (const [name, text] of [["repetitive", repetitiveText], ["varied", variedText]]) {
        const row = fixture(`long-${name}`);
        row.sourceSessionName = `Invented long ${name} work log`;
        row.userPrompt.text = text; row.followUpPrompts = []; row.toolCalls = []; row.httpRecords = [];
        result.push(row);
    }
    return result;
}
test("complete page-independent lexical IDs define both periods and frozen report scope, with complete long inputs", enabled, async t => {
    assert.equal(Buffer.byteLength(repetitiveText), 89489);
    assert.equal(Buffer.byteLength(variedText), 99575);
    const { context } = await privateFixture(t, rows());
    const engine = createSearchRetrieval(context, { source: inventedSource, modelDirectory, linguisticsDirectory: directory, onInvalidate: () => {} });
    t.after(() => engine.close());
    const built = await engine.build();
    assert.equal(built.mode, "hybrid"); assert.equal(built.items, 352);
    const types = ["action", "context", "interaction", "reply"];
    let matches, receipt;
    const status = await engine.search({ query: "fix my car", requestId: 0, types }, (hits, token) => { matches = hits; receipt = token; });
    assert.equal(matches.length, 63);
    assert.equal(new Set(matches.map(hit => hit.id)).size, 63);
    const pages = Array.from({ length: 4 }, (_, i) => matches.slice(i * 20, (i + 1) * 20));
    assert.deepEqual(pages.flat().map(hit => hit.id), matches.map(hit => hit.id));
    const state = await loadBoardState(context), scenarios = mergeEvidenceWithState(state);
    const stamp = { ...receipt, schemaVersion: 2, panelId: randomUUID(), epoch: 0, revision: state.revision,
        purpose: "strict-match-population", queryPurpose: "analysis", queryTypes: types, matchPolicyId: SEARCH_LEXICAL_POLICIES.matchPolicyId };
    assert.equal(searchWireContract.analysisReceipt(stamp), true);
    const selected = createSearchMembership({ revision: state.revision, scenarios, requestActivity: buildRequestActivity(scenarios) },
        { layer: "tool" }, [], matches, stamp, searchWireContract);
    const membership = { scenarioIds: selected.scenarioIds, actionIds: selected.actionIds, parentScenarioIds: selected.parentScenarioIds };
    assert.equal(membership.scenarioIds.length, 63);
    const input = { schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", groupBy: "workload", bucket: "day", limit: 8, filters: { scope: "all" },
            timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-29", to: "2026-09-29" }, later: { from: "2026-09-30", to: "2026-09-30" } },
        semanticSelection: { receipt: stamp }, withinServices: [] };
    const comparison = buildPeriodComparison(state, input, { semanticMembership: membership });
    assert.equal(comparison.periods.baseline.rowIds.length, 32);
    assert.equal(comparison.periods.later.rowIds.length, 31);
    const accepted = acceptPeriodReport(state, comparison, { semanticSelection: input.semanticSelection, resolveSemantic: () => membership });
    const frozen = freezePeriodReport(state, accepted, "2026-10-12T12:00:00.000Z").frozen;
    assert.equal(frozen.periods.baseline.rows.length, 32);
    assert.equal(frozen.periods.later.rows.length, 31);
    assert.deepEqual(frozen.comparison, comparison.comparison);
    let anchors;
    await engine.search({ query: "GET /me/calendarView 200", requestId: 1, types: ["action"] }, value => { anchors = value; });
    assert.equal(anchors.length, 62);
    // The optional grammar never clips a multi-sentence request into a qualifying short one.
    const longQuery = `${variedText}\nfix my car`;
    let complete;
    await engine.search({ query: longQuery, requestId: 2, types: ["interaction"] }, value => { complete = value; });
    assert.ok(complete.some(hit => hit.target.href === "#request?request=long-varied"));
    t.diagnostic(JSON.stringify({ scope: "65 interactions; 352 indexed items; unchanged synthetic long texts",
        built: built.metrics, buildItems: built.items, buildChunks: built.chunks,
        query: status.metrics, model: engine.status().model, linguistics: engine.status().linguistics,
        parentRss: process.memoryUsage().rss, parentPeakRss: process.resourceUsage().maxRSS * 1024,
        strictIds: 63, pages: 4, baselineRows: 32, laterRows: 31 }));
});

test("owned linguistic work can be cancelled during a full long parse and restart without stale state", enabled, async t => {
    let observe;
    const helper = createSearchLinguistics({ directory, onActivity: event => { if (event.state === "computing") observe?.resolve(); } });
    t.after(() => helper.close());
    const source = [{ id: "retained", revision: searchHash(repair), text: repair }];
    const prepared = await helper.prepare(source);
    const items = prepared.map((entry, i) => ({ ...source[i], intent: entry.intent }));
    observe = Promise.withResolvers();
    const controller = new AbortController();
    const pending = helper.match(variedText, items, { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.code === "linguistics-cancelled");
    await observe.promise;
    const began = performance.now();
    controller.abort();
    await rejected;
    const cancellationMs = performance.now() - began;
    observe = null;
    assert.deepEqual(await helper.match("fix my car", items), [{ id: source[0].id, revision: source[0].revision }]);
    t.diagnostic(JSON.stringify({ cancellationMs, originalInputBytes: Buffer.byteLength(variedText), replacementSucceeded: true }));
});
