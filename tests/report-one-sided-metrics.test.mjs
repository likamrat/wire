import test from "node:test";
import assert from "node:assert/strict";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { normalizeMetricFact } from "../lib/report-metric-comparison.mjs";
import { comparisonBodyHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";

const report = (id, metrics) => ({
    schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true,
    patternVersion: 1, metrics, toolRows: [{ id: `${id}-call`, patternId: "mail", outcome: "success" }],
    scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "fixture", callTimesAvailable: false, historyComplete: false },
});
const metric = (basis, numerator = 1) => ({
    metric: "accuracy", kind: "pass-rate", definitionId: "check-pass-share", definitionVersion: 1,
    unit: "percent", basis, aggregation: "pass-rate", boundary: "one-rule-per-eligible-unit",
    state: "available", coverage: { count: 2, eligible: 3 }, numerator, denominator: 2,
    counts: { pass: numerator, fail: 2 - numerator, unassessed: 1, evaluatorError: 0 },
    qualifiers: { checkId: "semantic-answer-correctness", checkVersion: 1 },
});

// Projection fixtures exercise supported comparison shapes, not real automatic semantic judgments.
for (const basis of ["user-assessment", "automatic-assessment"]) for (const side of ["baseline", "later"]) {
    test(`one-sided ${basis} retains the ${side} fact without a false delta`, () => {
        const fact = metric(basis, side === "baseline" ? 0 : 1);
        const before = structuredClone(fact);
        const result = compareFrozenReportFacts(report("a", side === "baseline" ? [fact] : []), report("b", side === "later" ? [fact] : []));
        const row = result.metrics.find(item => item.metric === "accuracy");
        const missing = side === "baseline" ? "later" : "baseline";
        assert.equal(row.status, "unavailable");
        assert.equal(row.reason, `${missing}-metric-not-saved`);
        assert.equal(row.delta, null);
        assert.deepEqual(row[side], normalizeMetricFact(fact));
        assert.equal(row[missing], null);
        assert.equal(row[side].basis, basis);
        assert.deepEqual(row[side].coverage, { count: 2, eligible: 3, missing: 1 });
        const formatting = createReportComparison();
        const origin = basis === "user-assessment" ? "Your feedback" : "Automatic local checks";
        assert.equal(formatting.definitionLabel(row), origin);
        assert.equal(formatting.metricPresentation(row[missing], "accuracy").value, "Not saved");
        assert.equal(formatting.metricPresentation(row[side], "accuracy").value, side === "baseline" ? "0%" : "50%");
        const html = comparisonBodyHtml(result);
        assert.ok(html.includes(origin));
        assert.match(html, /Not saved/);
        assert.match(html, /Not comparable/);
        const markdown = renderComparisonMarkdown(result, {
            bundleId: "export-fixture", preparedAtDisplay: "Synthetic one-sided proof",
            sourceReports: [result.baseline, result.later],
        });
        const line = markdown.split("\n").find(item => item.startsWith("| Accuracy"));
        assert.ok(line.includes(origin));
        assert.ok(line.includes(side === "baseline" ? "0%" : "50%"));
        assert.match(line, /Not saved/);
        assert.match(line, /Not comparable/);
        assert.deepEqual(fact, before);
    });
}

test("old one-sided stored summaries are qualified without reconstructing facts", () => {
    const old = {
        metric: "accuracy", comparisonKey: '["accuracy","check-pass-share","semantic-answer-correctness","user-personal"]',
        status: "unavailable", reason: "later-metric-not-saved", delta: null,
    };
    const before = JSON.stringify(old), formatting = createReportComparison();
    assert.equal(formatting.comparisonSidePresentation(old, "baseline").value, "Not preserved");
    assert.equal(formatting.comparisonSidePresentation(old, "later").value, "Not saved");
    assert.equal(formatting.definitionLabel(old), "Older comparison summary");
    assert.equal(JSON.stringify(old), before);
});

for (const side of ["baseline", "later"]) test(`one-sided unavailable automatic metric preserves ${side} provenance and reason`, () => {
    const fact = {
        ...metric("automatic-assessment"), state: "unavailable", reason: "unsupported-check",
        numerator: undefined, denominator: undefined, coverage: { count: 0, eligible: 3 },
        counts: { pass: 0, fail: 0, unassessed: 3, evaluatorError: 0 },
    };
    const result = compareFrozenReportFacts(report("a", side === "baseline" ? [fact] : []), report("b", side === "later" ? [fact] : []));
    const row = result.metrics.find(item => item.metric === "accuracy");
    assert.equal(row[side].value, null);
    assert.equal(row[side].reason, "unsupported-check");
    assert.equal(row[side].counts.unassessed, 3);
    assert.equal(row[side === "baseline" ? "later" : "baseline"], null);
    assert.equal(row.delta, null);
    const formatting = createReportComparison();
    assert.equal(formatting.definitionLabel(row), "Local observation (not a model assessment)");
    assert.equal(formatting.metricPresentation(row[side], "accuracy").value, "Not assessed");
});
