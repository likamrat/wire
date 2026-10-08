import test from "node:test";
import assert from "node:assert/strict";
import { applyGraphImport, coverageFor } from "../lib/collection.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { loadBoardState, mergeEvidenceWithState, moveCard } from "../lib/store.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { privateFixture } from "./helpers.mjs";

test("Graph expansion keeps Work IQ evidence, review state and distinct code-only counts", async (t) => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "reviewing");
    const original = await loadBoardState(context);
    const extracted = extractGraphActivities([
        { id: "graph-prompt", type: "user.message", timestamp: "2026-10-01T00:00:00Z", data: { content: "Synthetic Graph reference." } },
        { id: "graph-start", type: "tool.execution_start", timestamp: "2026-10-01T00:01:00Z", data: { toolName: "powershell", toolCallId: "graph-call", arguments: { command: "git diff # https://graph.microsoft.com/v1.0/me/messages" } } },
    ], { sessionId: "synthetic-graph-session" });
    const imported = {
        scenarios: extracted.scenarios, roster: [{ sessionId: "synthetic-graph-session", scanned: true }],
        coverage: { sourcesRequested: 1, sourcesScanned: 1, requestedDirectSites: 0, outputVisibleStatuses: 0, codeReferences: 1, syntheticReferences: 0 },
        exclusions: { "unresolved-network-target": 1 },
    };
    await applyGraphImport(context, imported);
    const state = await applyGraphImport(context, imported);
    const records = mergeEvidenceWithState(state);
    assert.deepEqual(state.cards["test-scenario"], original.cards["test-scenario"]);
    assert.equal(state.pseudonymKey, original.pseudonymKey);
    assert.equal(buildActivityAnalytics(records).totals.count, 1);
    assert.equal(buildActivityAnalytics(records, { layer: "direct-request" }).totals.count, 0);
    assert.equal(buildActivityAnalytics(records, { layer: "code-reference" }).totals.count, 1);
    assert.equal(new Set(records.map((record) => record.scenarioId)).size, records.length);
    const coverage = coverageFor(state, records);
    assert.equal(coverage.graphHistory.exclusions["unresolved-network-target"], 1);
    assert.ok(coverage.notes.some((note) => note.includes("Code references are not executions")));
});

test("retained source scans and current eligibility keep distinct counts, never a progress fraction", () => {
    const counts = { sourcesRequested: 3, sourcesScanned: 5, requestedDirectSites: 0, outputVisibleStatuses: 0, codeReferences: 7, syntheticReferences: 2 };
    const state = { importCoverage: { counts: {}, roster: [], dynamic: {}, graphHistory: { coverage: counts } } };
    const before = structuredClone(state);
    const coverage = coverageFor(state, []);
    assert.deepEqual(coverage.graphHistory.counts, counts);
    assert.equal(coverage.graphHistory.sourceCountBasis, "retained-scan-history");
    assert.ok(coverage.notes.some(note => note.includes("5 listed sources have been read at least once") && note.includes("3 sources are currently eligible")));
    assert.ok(coverage.notes.every(note => !note.includes("5 of 3")));
    assert.deepEqual(state, before);
    // An explicit one-shot Graph import can coexist with dynamic Work IQ coverage.
    state.importCoverage.graphHistory.roster = [];
    const imported = coverageFor(state, []);
    assert.equal(imported.graphHistory.sourceCountBasis, "single-scan");
    assert.ok(imported.notes.some(note => note.includes("3 sources were requested for scanning")));
    assert.deepEqual(imported.graphHistory.counts, counts);
});
