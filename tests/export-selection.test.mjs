import test from "node:test";
import assert from "node:assert/strict";
import { buildExportCatalog, selectExportSnapshot, summarizeExportSelection } from "../lib/export-selection.mjs";
import { fixture } from "./helpers.mjs";

test("all collected activity is canonical, excludes fixtures and diagnostics, and leaves source unchanged", () => {
    const first = fixture("first"), second = fixture("second");
    second.toolCalls[0].apiResults.push({ index: 1, statusCode: 404, evidenceLevel: "intermediary-reported" });
    const alias = { ...structuredClone(first), scenarioId: "legacy-alias", isLegacy: true };
    const sample = { ...fixture("sample"), sample: true };
    const diagnostic = { ...fixture("diagnostic"), workloadKind: "public-metadata-demonstration" };
    const unknown = { ...fixture("unknown"), sourceSessionId: null };
    const sources = [alias, first, second, sample, diagnostic, unknown];
    const before = JSON.stringify(sources);
    const catalog = buildExportCatalog(sources);
    assert.deepEqual(catalog.requests.map((r) => r.scenarioId), ["first", "second"]);
    assert.deepEqual(summarizeExportSelection(catalog), { requestGroups: 2, workIqActions: 2, returnedApiResults: 3, graphRequestSites: 0, graphVisibleStatuses: 0, ownedHttpRecords: 0, graphCodeReferences: 0 });
    assert.equal(summarizeExportSelection(catalog, ["first", "legacy-alias"]).workIqActions, 1);
    assert.equal(catalog.excluded.syntheticRequestGroups, 1);
    assert.equal(catalog.excluded.diagnosticRequestGroups, 1);
    assert.equal(catalog.excluded.unknownSourceRequestGroups, 1);
    assert.equal(catalog.excluded.duplicateEvidenceRecords, 1);
    assert.equal(selectExportSnapshot(sources, { kind: "all", revision: 7 }, 7).records.length, 2);
    assert.equal(selectExportSnapshot(sources, { kind: "current", scenarioIds: ["legacy-alias"], revision: 7 }, 7).records[0].scenarioId, "first");
    assert.equal(JSON.stringify(sources), before);
});

test("partial duplicate groups retain only unique eligible calls, with explicit request scope", () => {
    const first = fixture("first"), second = fixture("second");
    second.toolCalls.unshift(structuredClone(first.toolCalls[0]));
    second.toolCalls.push({ tool: "shell", toolCallId: "not-workiq", requestArgs: {} });
    second.toolCalls.push({ ...structuredClone(second.toolCalls[1]), toolCallId: "fixture-call", synthetic: true });
    const catalog = buildExportCatalog([first, second]);
    assert.equal(catalog.records[1].toolCalls.length, 1);
    assert.equal(catalog.records[1].toolCalls[0].toolCallId, "test-call-second");
    assert.equal(summarizeExportSelection(catalog).workIqActions, 2);
    assert.equal(selectExportSnapshot([first, second], { kind: "selected", scenarioIds: ["second"], revision: 1 }, 1).scope.requestGroups, 2);
});

test("selection rejects stale or malformed scope instead of widening or guessing", () => {
    const records = [fixture()];
    const select = (selection) => selectExportSnapshot(records, selection, 2);
    for (const selection of [null, {}, { kind: "all", revision: 1 }, { kind: "all", revision: 2, scenarioIds: [] }, { kind: "current", revision: 2, scenarioIds: [] }, { kind: "selected", revision: 2, scenarioIds: ["missing"] }, { kind: "selected", revision: 2, scenarioIds: ["test-scenario", "test-scenario"] }]) assert.throws(() => select(selection), /scope|selection|changed|Choose|available/i);
    assert.throws(() => selectExportSnapshot([{ ...fixture(), sample: true }], { kind: "all", revision: 2 }, 2), /no eligible/);
});
