import test from "node:test";
import assert from "node:assert/strict";
import { createReportScope } from "../web/report-scope.mjs";
import { buildExportCatalog, summarizeExportSelection } from "../lib/export-selection.mjs";
import { fixture } from "./helpers.mjs";

test("browser scope counts equal canonical backend selection and never change selected IDs", () => {
    const a = fixture("a"), b = fixture("b");
    const catalog = buildExportCatalog([a, b, { ...structuredClone(a), scenarioId: "old-a", isLegacy: true }]);
    const scope = createReportScope(), current = ["b"], selected = ["a", "old-a"];
    for (const kind of ["all", "current", "selected"]) {
        const value = scope.resolve(catalog, kind, current, selected);
        assert.deepEqual({ requestGroups: value.requests.length, ...value.counts }, summarizeExportSelection(catalog, value.ids || undefined));
        assert.deepEqual(value.selection(8), { kind, revision: 8, ...(kind === "all" ? {} : { scenarioIds: kind === "current" ? current : selected }) });
    }
    assert.deepEqual(selected, ["a", "old-a"]);
    assert.equal(scope.resolve(catalog, "all", current, selected).requests.length, 2);
    assert.equal(scope.resolve(catalog, "current", current, selected).requests.length, 1);
    assert.equal(scope.resolve(catalog, "selected", current, ["missing"]).excludedRequestedGroups, 1);
    assert.match(scope.summary(scope.resolve(catalog, "all", current, selected)), /separate units/);
});

test("one report is distinct from zero, singular, plural and alias-expanded requests and activity units", () => {
    const first = fixture("first"), overlap = fixture("overlap");
    overlap.toolCalls.unshift(structuredClone(first.toolCalls[0]));
    const catalog = buildExportCatalog([first, overlap]), scope = createReportScope();
    const none = scope.resolve(catalog, "selected", [], []);
    assert.equal(scope.inclusion(none), "No requests selected");
    assert.match(scope.summary(none), /^No requests selected/);
    const single = scope.resolve(catalog, "selected", [], ["first"]);
    assert.equal(scope.inclusion(single), "One report · 1 request group included");
    assert.match(scope.summary(single), /1 Work IQ tool call, 1 tool-returned API result,/);
    const expanded = scope.resolve(catalog, "selected", [], ["overlap"]);
    assert.equal(expanded.requests.length, 2);
    assert.equal(scope.inclusion(expanded), "One report · 2 request groups included");
    assert.match(scope.summary(expanded), /2 Work IQ tool calls, 2 tool-returned API results,/);
    assert.equal(scope.inclusion(scope.resolve(undefined, "selected", [], [])), "Report selection unavailable");
    assert.deepEqual(expanded.selection(1), { kind: "selected", revision: 1, scenarioIds: ["overlap"] });
});
