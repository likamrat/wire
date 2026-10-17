import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { searchFixture, searchRecords, streamPanel, saveSearchComparison } from "./live-search-fixture.mjs";
import { searchWireContract as wire, createSearchWireContract } from "../lib/search-wire-contract.mjs";
import { SEARCH_MATCH_POLICY_ID, SEARCH_TYPES } from "../lib/search-text.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { forbidSearchAi as forbidAi } from "./search-text-guards.mjs";

test("real HTTP text search covers every existing type and opens only its verified current target", { timeout: 60000 }, async t => {
    const guard = forbidAi(t);
    const records = searchRecords();
    records[0].userPrompt.text = "Build a PowerPoint deck for the planning review.";
    const app = await searchFixture(t, { records, formats: ["html", "json"] });
    guard.connect(app.runtime);
    const comparison = await saveSearchComparison(app, ["html"]);
    const panel = await streamPanel(app.runtime);
    t.after(() => panel.close());
    let requestId = 0, openId = 0;
    const queries = { interaction: "POWER", context: "SUBSEQUENT", reply: "LAB RES", action: "calendar",
        tool: "iq-fet", service: "ALEN", report: "POWER", comparison: "calendar", view: "timing", setting: "THEM" };
    for (const [type, query] of Object.entries(queries)) {
        await panel.api("/api/search/query", { query, requestId: ++requestId, types: [type] });
        const result = await panel.wait(event => event.event === "results" && event.requestId === requestId);
        assert.equal(wire.validResults(result), true, type);
        assert.equal(result.schemaVersion, 3);
        assert.equal(result.status.mode, "text");
        assert.ok(result.matches.hits.length > 0, type);
        assert.ok(result.matches.hits.every(hit => hit.type === type && hit.match === "text"));
        assert.equal(Object.hasOwn(result, "related"), false);
        for (const key of ["modelId", "model", "linguistics", "chunks"]) assert.equal(Object.hasOwn(result.status, key), false);
        const hit = result.matches.hits[0], receipt = result.matches.receipt;
        assert.equal(Object.hasOwn(receipt, "modelId"), false);
        assert.ok(hit.textMatch.end > hit.textMatch.start);
        const opened = await panel.api("/api/search/open", { id: hit.id, receipt, openId: ++openId });
        assert.equal(opened.code, 200, type);
        const document = await panel.wait(event => event.event === "opened" && event.openId === openId);
        if (type === "report") {
            assert.match(document.document.text, /PowerPoint/);
            assert.equal(hit.textMatch.field, "content");
            assert.match(hit.excerpt, /PowerPoint/);
        } else if (type === "comparison") {
            assert.equal(hit.target.bundleId, comparison.bundleId);
            assert.equal(document.document.kind, "html");
        } else assert.equal(document.document.kind, "route");
        assert.equal((await panel.api("/api/search/open", { id: "not-a-member", receipt, openId: ++openId })).code, 409);
    }
    assert.equal((await panel.api("/api/search/query", { schemaVersion: 2, query: "POWER", requestId: ++requestId })).code, 409);
    assert.equal((await panel.api("/api/search/query", { query: "POWER", requestId: ++requestId, types: ["unknown"] })).code, 422);
    await panel.api("/api/search/query", { query: "POWER", requestId: ++requestId });
    const navigation = await panel.wait(event => event.event === "results" && event.requestId === requestId);
    const state = await loadBoardState(app.context);
    const period = { schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-09-30", to: "2026-10-01" } },
        withinServices: [] };
    for (const receipt of [navigation.matches.receipt, { ...navigation.matches.receipt, queryPurpose: "analysis" }]) {
        const result = await panel.api("/api/period-comparison", { ...period, semanticSelection: { receipt } });
        assert.ok([409, 422].includes(result.code), "Navigation text matches cannot acquire analytical authority by relabeling.");
    }
    guard.verify();
});

test("actual typing queries retain all 63 matches, suppress stale publication and clear old receipts", { timeout: 30000 }, async t => {
    const guard = forbidAi(t);
    const records = searchRecords(63).map(record => ({ ...record, userPrompt: { ...record.userPrompt, text: "PowerPoint planning record" } }));
    const { runtime } = await searchFixture(t, { records });
    guard.connect(runtime);
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "P", requestId: 1, types: ["interaction"] });
    const original = await panel.wait(event => event.event === "results" && event.requestId === 1);
    await Promise.all(["PO", "POW", "POWER"].map((query, i) =>
        panel.api("/api/search/query", { query, requestId: i + 2, types: ["interaction"] })));
    const result = await panel.wait(event => event.event === "results" && event.requestId === 4);
    assert.equal(result.matches.total, 63);
    assert.equal(new Set(result.matches.hits.map(hit => hit.id)).size, 63);
    assert.equal(result.matches.receipt.indexId, original.matches.receipt.indexId);
    assert.deepEqual([0, 1, 2, 3].map(page => result.matches.hits.slice(page * 20, (page + 1) * 20).length), [20, 20, 20, 3]);
    assert.ok(result.matches.hits.every(hit => hit.excerpt.includes("PowerPoint")));
    const old = await panel.api("/api/search/query", { query: "calendar", requestId: 3 });
    assert.equal(old.body.state, "superseded");
    assert.equal((await panel.api("/api/search/open", {
        id: original.matches.hits[0].id, receipt: original.matches.receipt, openId: 1,
    })).code, 409);
    await panel.api("/api/search/query", { query: "", requestId: 5 });
    await panel.wait(event => event.event === "fence" && event.reason === "cancelled");
    assert.equal((await panel.api("/api/search/open", { id: result.matches.hits[0].id, receipt: result.matches.receipt, openId: 2 })).code, 409);
    assert.equal(panel.events.slice(panel.events.indexOf(result) + 1).some(event => event.event === "results" && event.requestId < 4), false);
    guard.verify();
});

test("current timing navigation indexes tool latency wording at its authoritative source", { timeout: 15000 }, async t => {
    const { runtime } = await searchFixture(t);
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "tool latenc", requestId: 1, types: ["view"] });
    const result = await panel.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(result.matches.total, 1);
    const hit = result.matches.hits[0];
    assert.equal(hit.title, "Recorded timing");
    assert.equal(hit.target.href, "#analyze?mode=calls");
    assert.equal(hit.target.focus, "activityView");
    const { start, end, excerptStart } = hit.textMatch;
    assert.equal(hit.textMatch.field, "content");
    assert.equal(hit.excerpt.slice(start - excerptStart, end - excerptStart), "tool latenc");
    assert.ok(hit.excerpt.includes("Compare individual tool latencies in Calls"));
    await panel.api("/api/search/query", { query: "recorded call durations", requestId: 2, types: ["view"] });
    const old = await panel.wait(event => event.event === "results" && event.requestId === 2);
    assert.equal(old.matches.total, 0, "No alias, display-only replacement or semantic rewrite remains.");
});

test("an indexed title without saved manifest authority never becomes searchable report text", { timeout: 15000 }, async t => {
    const { runtime, context, bundles } = await searchFixture(t, { formats: ["html"] });
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "activity report", requestId: 1, types: ["report"] });
    const legacy = await panel.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(legacy.matches.total, 1);
    assert.equal(legacy.matches.hits[0].textMatch.field, "title", "An absent canonical title preserves the real extracted legacy title.");
    await updateBoardState(context, state => {
        state.exports.find(artifact => artifact.bundleId === bundles[0].bundleId).title = "UNVERIFIED_INDEX_TITLE_CANARY";
    });
    runtime.search.invalidate();
    await panel.api("/api/search/query", { query: "UNVERIFIED_INDEX_TITLE_CANARY", requestId: 2, types: ["report"] });
    const unverified = await panel.wait(event => event.event === "results" && event.requestId === 2);
    assert.equal(unverified.matches.total, 0, "An index-only title is not a manifest-qualified corpus title.");
});

test("text membership uses actual complete wire populations for both periods and frozen report scope", { timeout: 30000 }, async t => {
    const guard = forbidAi(t);
    const records = searchRecords(63).map(record => ({ ...record, userPrompt: { ...record.userPrompt, text: "PowerPoint planning record" } }));
    const { runtime, context } = await searchFixture(t, { records });
    guard.connect(runtime);
    const events = [], response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        writeHead() {}, flushHeaders() {}, write(line) { events.push(JSON.parse(line)); }, end() { this.emit("close"); } });
    runtime.search.attach("text-membership", response, { schemaVersion: 3 });
    runtime.search.query("text-membership", { schemaVersion: 3, purpose: "analysis", query: "POWER", requestId: 1,
        types: ["interaction", "context", "reply", "action"] });
    const signal = AbortSignal.timeout(10000);
    while (!events.some(event => event.event === "results")) { signal.throwIfAborted(); await setImmediate(); }
    const event = events.find(value => value.event === "results"), stamp = event.matches.receipt;
    assert.equal(wire.validResults(event), true);
    assert.equal(event.matches.total, 63);
    const state = await loadBoardState(context), membership = runtime.search.membership("text-membership", stamp, state, "tool");
    assert.deepEqual(new Set(membership.scenarioIds), new Set(records.map(record => record.scenarioId)));
    const input = { schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-09-30", to: "2026-10-01" } },
        semanticSelection: { receipt: stamp }, withinServices: [] };
    const comparison = buildPeriodComparison(state, input, { semanticMembership: membership });
    for (const side of Object.values(comparison.periods)) assert.deepEqual(new Set(side.scenarioIds), new Set(membership.scenarioIds));
    const accepted = acceptPeriodReport(state, comparison, { semanticSelection: input.semanticSelection,
        resolveSemantic: () => runtime.search.membership("text-membership", stamp, state, "tool") });
    const frozen = freezePeriodReport(state, accepted, "2026-10-15T08:00:00.000Z").frozen;
    for (const side of Object.values(frozen.periods)) {
        assert.equal(side.rows.length, 63);
        assert.deepEqual(side.scenarioRefs, frozen.selection.semanticMembership.scenarioRefs);
    }
    runtime.search.cancel("text-membership");
    assert.throws(() => runtime.search.membership("text-membership", stamp, state, "tool"), /stale-search-membership/);
    await runtime.search.release("text-membership");
    guard.verify();
});

test("deletion and current-source loss invalidate text results without losing independently saved files", { timeout: 30000 }, async t => {
    const guard = forbidAi(t), records = searchRecords();
    records[0].userPrompt.text = "PowerPoint saved body marker";
    const { runtime, context, bundles } = await searchFixture(t, { records, formats: ["html", "json"] });
    guard.connect(runtime);
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "POWER", requestId: 1, types: ["report"] });
    const before = await panel.wait(event => event.event === "results" && event.requestId === 1);
    const deleted = before.matches.hits.find(hit => hit.target.bundleId === bundles[0].bundleId);
    const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context),
        onSeal: () => runtime.search.invalidate("deleted") });
    const preview = await deletion.previewArtifact("text-test", { artifactKind: "report", artifactId: bundles[0].bundleId });
    await deletion.confirmArtifact("text-test", { operationId: preview.operationId, confirmed: true });
    assert.equal((await panel.api("/api/search/open", {
        id: deleted.id, receipt: before.matches.receipt, openId: 1,
    })).code, 409);
    await panel.api("/api/search/query", { query: "POWER", requestId: 2, types: ["report"] });
    const after = await panel.wait(event => event.event === "results" && event.requestId === 2);
    assert.deepEqual(after.matches.hits.map(hit => hit.target.bundleId), [bundles[1].bundleId]);
    await runtime.collector.close();
    runtime.search.invalidate("source-unavailable");
    await panel.api("/api/search/query", { query: "LAB RES", requestId: 3, types: ["reply"] });
    const missing = await panel.wait(event => event.event === "results" && event.requestId === 3);
    assert.deepEqual(missing.matches.hits, []);
    assert.equal(missing.status.corpus.state, "partial");
    assert.ok(missing.status.corpus.issues.some(issue => issue.code === "source-unavailable"));
    await panel.api("/api/search/query", { query: "POWER", requestId: 4, types: ["report"] });
    const independent = await panel.wait(event => event.event === "results" && event.requestId === 4);
    assert.deepEqual(independent.matches.hits.map(hit => hit.target.bundleId), [bundles[1].bundleId]);
    assert.equal((await panel.api("/api/search/open", {
        id: independent.matches.hits[0].id, receipt: independent.matches.receipt, openId: 2,
    })).code, 200);
    await panel.api("/api/search/query", { query: "POWER", requestId: 5, types: ["interaction"] });
    const retained = await panel.wait(event => event.event === "results" && event.requestId === 5);
    assert.equal(retained.matches.total, 1);
    guard.verify();
});

test("closed v3 text receipts and range metadata cannot be relabeled semantic or Related authority", () => {
    const contract = new Function("return (" + createSearchWireContract.toString() + ")")()({
        matchPolicyId: SEARCH_MATCH_POLICY_ID, types: SEARCH_TYPES,
    });
    const stamp = { schemaVersion: 3, panelId: "11111111-1111-4111-8111-111111111111", epoch: 0,
        requestId: 1, generation: 1, indexId: "1".repeat(64), mode: "text", revision: 1,
        queryPurpose: "analysis", queryTypes: [...wire.allTypes], purpose: "strict-match-population", matchPolicyId: SEARCH_MATCH_POLICY_ID };
    assert.equal(contract.analysisReceipt(stamp), true);
    assert.equal(contract.analysisReceipt({ ...stamp, queryPurpose: "navigation" }), false);
    for (const key of ["panelId", "epoch", "requestId", "generation", "indexId", "revision", "queryPurpose", "queryTypes"]) {
        const changed = { ...stamp, [key]: typeof stamp[key] === "number" ? stamp[key] + 1
            : key === "queryPurpose" ? "navigation" : key === "queryTypes" ? ["interaction"]
                : key === "panelId" ? "22222222-2222-4222-8222-222222222222" : "2".repeat(64) };
        assert.equal(contract.sameReceipt(stamp, changed), false, key);
    }
    for (const types of [null, "interaction", ["interaction", "interaction"], ["unknown"]]) {
        assert.throws(() => contract.query({ schemaVersion: 3, purpose: "navigation", query: "POWER", requestId: 1, types }));
    }
    for (const changed of [{ ...stamp, schemaVersion: 2 }, { ...stamp, modelId: "2".repeat(64) },
        { ...stamp, mode: "hybrid" }, { ...stamp, mode: "lexical-only" }, { ...stamp, purpose: "related-navigation" },
        { ...stamp, matchPolicyId: "7a1856ac8d53036a49501aaf0e9631a621c381b5338ec757762b9af0342f9b7c" }]) {
        assert.equal(contract.validReceipt(changed), false);
    }
    const hit = { id: "literal", revision: "3".repeat(64), type: "interaction", title: "Recorded request",
        source: { label: "Original source" }, excerpt: "PowerPoint", match: "text",
        textMatch: { field: "content", start: 0, end: 5, excerptStart: 0 } };
    const event = { schemaVersion: 3, panelId: stamp.panelId, epoch: 0, event: "results", requestId: 1, purpose: "analysis",
        matches: { receipt: stamp, hits: [hit], total: 1 },
        status: { mode: "text", indexId: stamp.indexId, corpus: { state: "ready", generation: 1 } } };
    assert.equal(contract.validResults(event), true);
    assert.equal(contract.validResults({ ...event, matches: { ...event.matches, total: 2 } }), false);
    assert.equal(contract.validResults({ ...event, matches: { ...event.matches, hits: [hit, hit], total: 2 } }), false);
    for (const match of ["exact", "prefix", "semantic"]) {
        assert.throws(() => createSearchMembership({ revision: 1, scenarios: [], requestActivity: { tool: [] } },
            { layer: "tool" }, [], [{ ...hit, match }], stamp, contract), /current strict analysis receipt/);
        assert.equal(contract.validResults({ ...event, matches: { ...event.matches, hits: [{ ...hit, match }] } }), false);
    }
    for (const textMatch of [{ ...hit.textMatch, end: 11 }, { ...hit.textMatch, start: -1 },
        { ...hit.textMatch, field: "hidden" }, { ...hit.textMatch, excerptStart: 1 }, { ...hit.textMatch, extra: true }]) {
        assert.equal(contract.validResults({ ...event, matches: { ...event.matches, hits: [{ ...hit, textMatch }] } }), false);
    }
    assert.equal(contract.validResults({ ...event, related: {} }), false);
});
