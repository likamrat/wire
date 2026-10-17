import test from "node:test";
import assert from "node:assert/strict";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts, projectCurrentEvaluationFacts, adaptEvaluationReport } from "../lib/report-facts.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { makeCost } from "./report-comparison-fixtures.mjs";
import { fixture } from "./helpers.mjs";

function legacyFacts() {
    const record = fixture("legacy-quality"), state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [record] };
    const value = structuredClone(buildReportFacts(state.evidence, state).facts);
    delete value.metricProjectionVersion;
    const cost = makeCost("measured"), interactionRef = value.memberships[0].interactionRef;
    Object.assign(cost, { basis: value.basis, eligibleUnitRefs: [interactionRef], coveredUnitRefs: [interactionRef] });
    value.metrics.push(cost);
    return freezeEvaluationFacts(value);
}

test("current projection rejects retired metrics while historical validation preserves them byte-for-byte", () => {
    const legacy = legacyFacts(), original = JSON.stringify(legacy), projected = projectCurrentEvaluationFacts(legacy);
    assert.ok(legacy.metrics.some(metric => metric.dimension === "cost" && metric.value === 0.25));
    assert.equal(projected.metricProjectionVersion, 2);
    assert.equal(projected.metrics.some(metric => metric.dimension === "cost"), false);
    assert.deepEqual(projected.metrics, legacy.metrics.filter(metric => metric.dimension !== "cost"));
    assert.equal(JSON.stringify(legacy), original);
    assert.throws(() => freezeEvaluationFacts({ ...legacy, metricProjectionVersion: 2 }), /retired-current-metric/);
});

test("new JSON, HTML, Markdown and manifest omit Cost even when supplied valid historical facts", async () => {
    const legacy = legacyFacts(), original = JSON.stringify(legacy);
    const bundle = await buildSanitizedBundle([fixture("legacy-quality")], "a".repeat(64),
        { promptMode: "none", formats: ["html", "json", "markdown"] }, undefined, undefined, legacy);
    for (const name of ["product-report.json", "coverage-and-redaction-manifest.json"]) {
        const value = JSON.parse(bundle.files[name]);
        assert.equal(value.evaluationFacts.metricProjectionVersion, 2);
        assert.equal(value.evaluationFacts.metrics.some(metric => metric.dimension === "cost"), false);
    }
    for (const name of ["product-report.html", "product-report.md"]) assert.doesNotMatch(bundle.files[name], />Cost<|\| Cost \|/);
    assert.match(bundle.files["product-report.md"], /\| Speed \| Median tool latency \|/);
    assert.match(bundle.files["product-report.md"], /\| Speed \| Time to recorded final response \|/);
    assert.equal(JSON.stringify(legacy), original);
});

test("old/new comparison omits Cost without zero or a delta and leaves compatible timing independent", () => {
    const legacy = legacyFacts(), current = projectCurrentEvaluationFacts(legacy), original = JSON.stringify(legacy);
    const a = adaptEvaluationReport(legacy, { bundleId: "export-old", snapshotHash: "a".repeat(64), disclosureReviewed: true });
    const b = adaptEvaluationReport(current, { bundleId: "export-new", snapshotHash: "b".repeat(64), disclosureReviewed: true });
    assert.ok(a.metrics.some(metric => metric.metric === "cost"));
    const comparison = compareFrozenReportFacts(a, b);
    assert.equal(comparison.metricProjectionVersion, 2);
    assert.equal(comparison.metrics.some(metric => metric.metric === "cost"), false);
    assert.ok(comparison.metrics.some(metric => metric.metric === "speed"));
    assert.equal(JSON.stringify(legacy), original);
});
