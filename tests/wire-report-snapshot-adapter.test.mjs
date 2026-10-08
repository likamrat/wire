import test from "node:test";
import assert from "node:assert/strict";
import * as contract from "../lib/assessment-contract.mjs";
import { makeSnapshot, id } from "./report-comparison-fixtures.mjs";
import { createWireReportAdapter, verifiedReportIdentityRelation } from "../lib/wire-report-snapshot-adapter.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";

const metadata = (letter = "a") => ({ bundleId: `export-${letter}`, snapshotHash: letter.repeat(64), disclosureReviewed: true });
const adapt = createWireReportAdapter(contract);

test("exact partial/unknown outcomes survive independently from binary check shares", () => {
    const facts = makeSnapshot();
    const result = adapt(facts, metadata());
    assert.equal(result.toolRows.length, 1);
    assert.equal(result.toolRows[0].outcome, "partial");
    assert.equal(result.outcomeLayers["graph-request-site"][0].outcome, "unknown");
    assert.equal(result.outcomeLayers["returned-api-entry"][0].outcome, "failure");
    assert.equal(result.outcomeLayers["owned-http"][0].outcome, "transport");
    assert.equal(result.layerCounts["graph-code-reference"], 1);
    assert.equal(result.outcomeLayers["graph-code-reference"], undefined);
});

test("execution checks are not promoted into accuracy or trust metrics", () => {
    const result = adapt(makeSnapshot(), metadata());
    assert.deepEqual(result.metrics, []);
    const comparison = compareFrozenReportFacts(result, { ...structuredClone(result), ...metadata("b") });
    assert.ok(comparison.metrics.every(metric => metric.status === "unavailable" && metric.reason === "metric-not-saved"));
});

test("missing patterns do not discard calls or invent a shared endpoint cohort", () => {
    const facts = makeSnapshot();
    facts.patterns = [];
    const result = adapt(facts, metadata());
    assert.equal(result.toolRows.length, 1);
    assert.equal(result.missingPatterns, 4);
    assert.ok(result.patterns.every(pattern => !pattern.available));
    assert.equal(new Set(result.patterns.map(pattern => pattern.patternId)).size, 4);
});

test("safe technical pattern display needs the trusted endpoint validator", () => {
    const facts = makeSnapshot();
    Object.assign(facts.patterns[0].pattern, {
        targetShape: "single",
        display: {
            tool: "workiq-fetch", workload: "Mail", attribution: "requested-single-target",
            endpoints: [{ pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: ["$select"] }],
        },
    });
    assert.throws(() => adapt(facts, metadata()), /trusted-endpoint-validator-required/);
    const withValidator = createWireReportAdapter(contract, {
        validateEndpoint: endpoint => endpoint.pathTemplate === "/me/messages" && endpoint.method === null && endpoint.apiVersion === null,
    });
    const result = withValidator(facts, metadata());
    assert.equal(result.patterns.find(pattern => pattern.available).tool, "workiq-fetch");
    assert.deepEqual(result.patterns.find(pattern => pattern.available).endpoints[0].queryKeys, ["$select"]);
    facts.patterns[0].pattern.display.endpoints[0].pathTemplate = "/private-literal";
    assert.throws(() => withValidator(facts, metadata()), /unsafe-endpoint-projection/);
});

test("namespace equality alone is not treated as verified overlap evidence", () => {
    const a = adapt(makeSnapshot(), metadata()), b = adapt(makeSnapshot(), metadata("b"));
    assert.equal(verifiedReportIdentityRelation(a, b), "unknown");
    assert.equal(verifiedReportIdentityRelation(a, b, { namespaceProvenanceVerified: true }), "same-namespace");
    b.namespace.ref = id("namespace", 2);
    assert.equal(verifiedReportIdentityRelation(a, b, { namespaceProvenanceVerified: true }), "unknown");
});

test("the report adapter does not infer call dates or complete history from selected scope", () => {
    const facts = makeSnapshot();
    facts.scope.from = "2026-10-01T00:00:00.000Z";
    facts.scope.untilExclusive = "2026-10-05T00:00:00.000Z";
    const result = adapt(facts, metadata());
    assert.equal(result.scope.callTimesAvailable, false);
    assert.equal(result.scope.historyComplete, false);
    assert.equal(result.scope.selectedFrom, facts.scope.from);
    assert.equal(result.scope.collectionDefinition, null);
});

test("unreviewed snapshots fail and source facts remain unchanged", () => {
    const facts = makeSnapshot(), before = structuredClone(facts);
    assert.throws(() => adapt(facts, { ...metadata(), disclosureReviewed: false }), /disclosure-reviewed/);
    adapt(facts, metadata());
    assert.deepEqual(facts, before);
    assert.equal(Object.isFrozen(facts), false);
});
