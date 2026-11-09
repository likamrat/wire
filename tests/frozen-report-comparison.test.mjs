import test from "node:test";
import assert from "node:assert/strict";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";

const passRate = (metric, numerator) => ({
    metric, kind: "pass-rate", definitionId: `${metric}-checks`, definitionVersion: 1,
    unit: "percent", basis: "automatic-assessment", aggregation: "pass-rate",
    boundary: "eligible-interactions", state: "available",
    coverage: { count: 10, eligible: 12 }, numerator, denominator: 10,
});
const report = (id, overrides = {}) => ({
    schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true,
    patternVersion: 1,
    metrics: { accuracy: passRate("accuracy", 8), "answer-trust": passRate("answer-trust", 9), "action-trust": passRate("action-trust", 7) },
    toolRows: [{ id: `${id}-call`, patternId: "mail", outcome: "success" }],
    scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "approved-history-v1", callTimesAvailable: false, historyComplete: false },
    ...overrides,
});

test("current comparison keeps four metric results separate, leaves unsaved speed unavailable and omits Cost", () => {
    const baseline = report("a"), later = report("b");
    later.metrics.accuracy.numerator = 9;
    later.metrics["action-trust"].numerator = 6;
    const result = compareFrozenReportFacts(baseline, later, { identityRelation: "same-namespace" });
    assert.equal(result.status, "ready");
    assert.equal(result.metrics.length, 4);
    assert.equal(result.metrics.find(value => value.metric === "accuracy").delta.value, 10);
    assert.equal(result.metrics.find(value => value.metric === "action-trust").delta.value, -10);
    assert.equal(result.metrics.find(value => value.metric === "answer-trust").delta.value, 0);
    assert.equal(result.metrics.some(value => value.metric === "cost"), false);
    assert.equal(result.metricProjectionVersion, 2);
    assert.equal(result.metrics.find(value => value.metric === "speed").delta, null);
});

test("earlier and later references bind the exact source hashes", () => {
    const baseline = report("a"), later = report("b");
    const result = compareFrozenReportFacts(baseline, later);
    assert.deepEqual(result.baseline, { bundleId: baseline.bundleId, snapshotHash: baseline.snapshotHash });
    assert.deepEqual(result.later, { bundleId: later.bundleId, snapshotHash: later.snapshotHash });
    assert.equal(result.toolComparison.overlap.verified, false);
});

test("same-snapshot selection is rejected without manufacturing a useful delta", () => {
    const baseline = report("a");
    const result = compareFrozenReportFacts(baseline, structuredClone(baseline));
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "same-snapshot");
    assert.equal(result.metrics.length, 0);
});

test("one report identity cannot silently carry two different frozen versions", () => {
    assert.throws(() => compareFrozenReportFacts(report("a"), report("b", { bundleId: "export-a" })), /conflicting snapshot hashes/);
});

test("scope changes qualify the narrative without suppressing the raw observed values", () => {
    const baseline = report("a"), later = report("b");
    baseline.toolRows[0].outcome = "failure";
    later.scope.selectionKind = "all";
    const result = compareFrozenReportFacts(baseline, later, { identityRelation: "same-namespace" });
    assert.equal(result.toolComparison.raw.change.success, 100);
    assert.ok(result.scopeDifferences.includes("selection-kind-differs"));
    assert.ok(result.scopeDifferences.includes("per-call-time-windows-unverified"));
    assert.equal(result.narrative.tone, "neutral");
    assert.match(result.narrative.detail, /verdict is withheld/);
});

test("changed pattern definitions never produce a matched-pattern delta", () => {
    const result = compareFrozenReportFacts(report("a"), report("b", { patternVersion: 2 }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "pattern-definition-changed");
    assert.equal(result.toolComparison, null);
    assert.equal(result.metrics.find(value => value.metric === "accuracy").status, "comparable");
});

test("older normalized fact versions remain unsupported rather than implicitly upgraded", () => {
    const result = compareFrozenReportFacts(report("a"), report("b", { schemaVersion: 2 }));
    assert.equal(result.reason, "unsupported-facts-version");
    assert.equal(result.toolComparison, null);
});

test("unconfirmed facts and dimension relabeling fail before comparison", () => {
    assert.throws(() => compareFrozenReportFacts(report("a"), report("b", { disclosureReviewed: false })), /save confirmation/);
    assert.doesNotThrow(() => compareFrozenReportFacts(report("a"), report("b", { disclosureReviewed: false, localSaveConfirmed: true })));
    assert.throws(() => compareFrozenReportFacts(report("a"), report("b", { metrics: { accuracy: passRate("answer-trust", 8) } })), /dimension identities/);
});

test("comparison never mutates supplied snapshot facts", () => {
    const baseline = report("a"), later = report("b"), before = structuredClone([baseline, later]);
    compareFrozenReportFacts(baseline, later);
    assert.deepEqual([baseline, later], before);
});

test("multiple speed definitions remain separate rather than overwriting a dimension", () => {
    const speed = (definitionId, boundary, value) => ({
        metric: "speed", kind: "duration", definitionId, definitionVersion: 1,
        unit: "ms", basis: "observed", aggregation: "median", boundary,
        state: "available", coverage: { count: 1, eligible: 1 }, value,
    });
    const baseline = report("a", { metrics: [speed("tool-duration", "tool-start-to-completion", 1000), speed("http-duration", "http-start-to-headers", 200)] });
    const later = report("b", { metrics: [speed("tool-duration", "tool-start-to-completion", 900), speed("http-duration", "http-start-to-headers", 250)] });
    const result = compareFrozenReportFacts(baseline, later);
    const comparisons = result.metrics.filter(metric => metric.metric === "speed");
    assert.equal(comparisons.length, 2);
    assert.deepEqual(comparisons.map(metric => metric.delta.value), [50, -100]);
});

test("automatic and personal origins are not silently matched as the same measurement", () => {
    const baseline = report("a", { metrics: [passRate("accuracy", 8)] });
    const later = report("b", { metrics: [{ ...passRate("accuracy", 9), basis: "user-assessment" }] });
    const result = compareFrozenReportFacts(baseline, later);
    const accuracy = result.metrics.filter(metric => metric.metric === "accuracy");
    assert.equal(accuracy.length, 2);
    assert.ok(accuracy.every(metric => metric.status === "unavailable" && metric.delta === null));
});

test("duplicate active metric keys must be pooled explicitly instead of last-one-wins", () => {
    assert.throws(() => compareFrozenReportFacts(
        report("a", { metrics: [passRate("accuracy", 8), passRate("accuracy", 9)] }), report("b"),
    ), /Duplicate active metric comparison identity/);
});

test("malformed metrics cannot hide in a one-sided unmatched dimension", () => {
    const baseline = report("a", { metrics: [{ ...passRate("accuracy", 8), denominator: 0 }] });
    assert.throws(() => compareFrozenReportFacts(baseline, report("b", { metrics: [] })), /assessed counts/);
});

test("pattern labels cannot silently change underneath the same comparison key", () => {
    const display = {
        patternId: "mail", unitKind: "tool-call", tool: "workiq-fetch", workload: "Mail",
        attribution: "requested-single-target", targetShape: "single", available: true,
        endpoints: [{ pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: [] }],
    };
    const baseline = report("a", { patterns: [display] }), later = report("b", { patterns: [structuredClone(display)] });
    const result = compareFrozenReportFacts(baseline, later);
    assert.equal(result.patternDisplays.length, 1);
    assert.equal(result.patternDisplays[0].tool, "workiq-fetch");
    later.patterns[0].workload = "Files";
    assert.throws(() => compareFrozenReportFacts(baseline, later), /conflicting display metadata/);
});

test("equivalent batch endpoint and query-key ordering does not create a false pattern conflict", () => {
    const display = {
        patternId: "batch", unitKind: "tool-call", tool: "workiq-fetch", workload: "Multiple workloads",
        attribution: "requested-batch-targets", targetShape: "multiple", available: true,
        endpoints: [
            { pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: ["$top", "$select"] },
            { pathTemplate: "/me/events", method: null, apiVersion: null, queryKeys: [] },
        ],
    };
    const reversed = structuredClone(display);
    reversed.endpoints[0].queryKeys.reverse();
    reversed.endpoints.reverse();
    const result = compareFrozenReportFacts(report("a", { patterns: [display] }), report("b", { patterns: [reversed] }));
    assert.equal(result.patternDisplays.length, 1);
});

test("API entries, owned HTTP and Graph sites compare separately from calls", () => {
    const layers = prefix => ({
        "returned-api-entry": [{ id: `${prefix}-api-1`, patternId: "mail-api", outcome: "success" }, { id: `${prefix}-api-2`, patternId: "mail-api", outcome: "failure" }],
        "owned-http": [{ id: `${prefix}-http`, patternId: "mail-http", outcome: "transport" }],
        "graph-request-site": [{ id: `${prefix}-site`, patternId: "mail-site", outcome: "unknown" }],
    });
    const result = compareFrozenReportFacts(
        report("a", { outcomeLayers: layers("a"), layerCounts: { "graph-code-reference": 4 } }),
        report("b", { outcomeLayers: layers("b"), layerCounts: { "graph-code-reference": 6 } }),
    );
    assert.equal(result.toolComparison.raw.baseline.count, 1);
    assert.equal(result.layerComparisons["returned-api-entry"].raw.baseline.count, 2);
    assert.equal(result.layerComparisons["owned-http"].raw.baseline.transport, 1);
    assert.equal(result.layerComparisons["graph-request-site"].raw.baseline.unknown, 1);
    assert.match(result.layerComparisons["returned-api-entry"].note, /not.*independent/);
    assert.match(result.layerComparisons["graph-request-site"].note, /not measured wire-execution/);
    assert.equal(result.layerComparisons["graph-code-reference"].status, "not-scored");
    assert.equal(result.layerComparisons["graph-code-reference"].baselineCount, 4);
    assert.equal(Object.hasOwn(result.layerComparisons["graph-code-reference"], "successRate"), false);
});

test("missing layer data differs from an explicitly empty layer", () => {
    const baseline = report("a", { outcomeLayers: { "owned-http": [] } });
    const later = report("b", { outcomeLayers: { "owned-http": [] } });
    const result = compareFrozenReportFacts(baseline, later);
    assert.equal(result.layerComparisons["owned-http"].raw.baseline.count, 0);
    assert.equal(result.layerComparisons["returned-api-entry"].reason, "layer-not-saved");
    assert.equal(result.layerComparisons["graph-code-reference"].baselineCount, null);
});

test("Graph-only reports get an explicit Graph comparison instead of an empty tool verdict", () => {
    const sites = prefix => [{ id: `${prefix}-site`, patternId: "graph-mail", outcome: "success" }];
    const result = compareFrozenReportFacts(
        report("a", { toolRows: [], outcomeLayers: { "graph-request-site": sites("a") } }),
        report("b", { toolRows: [], outcomeLayers: { "graph-request-site": sites("b") } }),
        { identityRelation: "same-namespace" },
    );
    assert.equal(result.primaryLayer, "graph-request-site");
    assert.equal(result.primaryEvidence.unitLabel, "request sites");
    assert.match(result.narrative.heading, /Graph request sites/);
    assert.match(result.narrative.detail, /not measured wire executions/);
    assert.equal(result.toolComparison.raw.baseline.count, 0);
});
