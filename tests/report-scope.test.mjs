import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReportScope } from "../web/report-scope.mjs";
import { buildExportCatalog, summarizeExportSelection } from "../lib/export-selection.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { fixture } from "./helpers.mjs";
import { nativeReportFrame } from "./native-report-fixtures.mjs";

test("native conversations keep separate report counts and cannot be silently removed by GitHub author filtering",
    { skip: !process.env.WIRE_BOUNDED_BACKEND_ROOT }, async () => {
    const { buildNativeExportRequests } = await import(pathToFileURL(
        path.join(process.env.WIRE_BOUNDED_BACKEND_ROOT, "lib", "export-selection.mjs")).href);
    const github = buildExportCatalog([fixture()]);
    const native = buildNativeExportRequests(nativeReportFrame().records);
    const scope = createReportScope(promptAuthorship);
    const catalog = { ...github, requests: [...github.requests, ...native] };
    const all = scope.resolve(catalog, "all", [], []);
    assert.equal(all.available, true);
    assert.equal(all.requests.length, 3);
    assert.equal(all.counts.workIqActions, 1);
    assert.equal(all.nativeCounts.calls, 3);
    assert.match(scope.summary(all), /Microsoft/);
    assert.match(scope.summary(all), /1 Work IQ tool call/);
    const narrowed = scope.resolve(catalog, "all", [], [], ["user"]);
    assert.equal(narrowed.available, false);
    assert.equal(narrowed.requests.filter(request => request.recordKind === "native-conversation").length, 2);
    assert.match(scope.summary(narrowed), /all prompt authors/);
});

test("browser scope counts equal canonical backend selection and never change selected IDs", () => {
    const a = fixture("a"), b = fixture("b");
    const catalog = buildExportCatalog([a, b, { ...structuredClone(a), scenarioId: "old-a", isLegacy: true }]);
    const scope = createReportScope(), current = ["b"], selected = ["a", "old-a"];
    for (const kind of ["all", "current", "selected"]) {
        const value = scope.resolve(catalog, kind, current, selected);
        assert.equal(value.sourceSessionCount, 1);
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
    assert.equal(scope.inclusion(single), "One report with 1 request group included");
    assert.match(scope.summary(single), /1 Work IQ tool call, 1 tool-returned API result,/);
    const expanded = scope.resolve(catalog, "selected", [], ["overlap"]);
    assert.equal(expanded.requests.length, 2);
    assert.equal(scope.inclusion(expanded), "One report with 2 request groups included");
    assert.match(scope.summary(expanded), /2 Work IQ tool calls, 2 tool-returned API results,/);
    assert.equal(scope.inclusion(scope.resolve(undefined, "selected", [], [])), "Report selection unavailable");
    assert.deepEqual(expanded.selection(1), { kind: "selected", revision: 1, scenarioIds: ["overlap"] });
});

test("source chat counts follow complete canonical scope and report authors, not one results page", () => {
    const records = Array.from({ length: 9 }, (_, index) => {
        const record = fixture(`chat-count-${index}`);
        record.sourceSessionId = index === 8 ? "later-page-chat" : "shared-chat";
        record.userPrompt.authorship = index === 8 ? { actor: "agent", basis: "source-agent" } : { actor: "user", basis: "source-user" };
        return record;
    });
    const alias = { ...structuredClone(records[0]), scenarioId: "preserved-alias", isLegacy: true };
    const empty = { ...fixture("no-reportable-activity"), sourceSessionId: "empty-chat", toolCalls: [] };
    const catalog = buildExportCatalog([alias, ...records, empty]), before = structuredClone(catalog);
    const scope = createReportScope(promptAuthorship), matchingIds = records.map(record => record.scenarioId);
    const firstPageIds = matchingIds.slice(0, 8), selectedIds = [matchingIds[0], alias.scenarioId, matchingIds[8]];

    const all = scope.resolve(catalog, "all", firstPageIds, selectedIds);
    assert.equal(all.requests.length, 9);
    assert.equal(all.sourceSessionCount, 2);
    assert.equal(all.counts.workIqActions, 9);
    assert.deepEqual(all.selection(7), { kind: "all", revision: 7 });
    assert.equal(scope.resolve(catalog, "current", matchingIds, []).sourceSessionCount, 2);
    assert.equal(scope.resolve(catalog, "current", firstPageIds, []).sourceSessionCount, 1);

    const selected = scope.resolve(catalog, "selected", firstPageIds, selectedIds);
    assert.equal(selected.requests.length, 2, "Canonical aliases do not add another interaction");
    assert.equal(selected.sourceSessionCount, 2, "A selected chat outside the current view stays included");
    assert.deepEqual(selected.selection(7), { kind: "selected", revision: 7, scenarioIds: selectedIds });

    const userOnly = scope.resolve(catalog, "all", firstPageIds, selectedIds, ["user"]);
    assert.equal(userOnly.sourceSessionCount, 1);
    assert.equal(userOnly.requests.length, 8);
    assert.equal(userOnly.authorExcludedRequestGroups, 1);
    assert.equal(scope.resolve(catalog, "all", firstPageIds, selectedIds, ["agent"]).sourceSessionCount, 1);
    assert.equal(scope.resolve(catalog, "all", firstPageIds, selectedIds, ["user", "agent"]).sourceSessionCount, 2);
    assert.deepEqual(catalog, before);
    assert.deepEqual(selectedIds, [matchingIds[0], alias.scenarioId, matchingIds[8]]);
});

test("source chat counts distinguish known empty membership from unavailable source identities", () => {
    const scope = createReportScope(promptAuthorship), record = fixture("known");
    record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    const catalog = buildExportCatalog([record]);
    assert.equal(scope.resolve(catalog, "selected", [], []).sourceSessionCount, 0);
    assert.equal(scope.resolve(buildExportCatalog([]), "all", [], []).sourceSessionCount, 0);
    assert.equal(scope.resolve(catalog, "all", [], [], ["agent"]).sourceSessionCount, 0);
    for (const unavailable of [undefined, null, {}]) {
        assert.equal(scope.resolve(unavailable, "all", [], []).sourceSessionCount, null);
    }
    for (const sourceSessionId of [undefined, null, "", 1]) {
        const incomplete = { ...catalog, requests: [{ ...catalog.requests[0], sourceSessionId }] };
        const result = scope.resolve(incomplete, "all", [], []);
        assert.equal(result.requests.length, 1);
        assert.equal(result.sourceSessionCount, null);
    }
});
