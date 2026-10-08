import test from "node:test";
import assert from "node:assert/strict";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonMarkdown, comparisonBodyHtml } from "../lib/report-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";

test("a one-in-ten-thousand change remains nonzero in app, HTML and Markdown comparisons", () => {
    const report = (prefix, failures) => ({
        schemaVersion: 1, bundleId: `export-${prefix}`, snapshotHash: prefix.repeat(64), disclosureReviewed: true,
        patternVersion: 1, metrics: [],
        toolRows: Array.from({ length: 10000 }, (_, index) => ({ id: `${prefix}-${index}`, patternId: "mail", outcome: index < failures ? "failure" : "success" })),
        patterns: [{
            patternId: "mail", unitKind: "tool-call", tool: "workiq-fetch", workload: "Mail", attribution: "requested-single-target",
            targetShape: "single", available: true, endpoints: [{ pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: [] }],
        }],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic", callTimesAvailable: false, historyComplete: false },
    });
    const model = compareFrozenReportFacts(report("a", 1), report("b", 0), { identityRelation: "same-namespace" });
    assert.equal(model.toolComparison.patterns[0].change.failure, -0.01);
    assert.equal(createReportComparison().formatValue(-0.01, "percentage-points"), "-0.01 pp");
    assert.match(comparisonBodyHtml(model), /0\.01 pp/);
    const markdown = renderComparisonMarkdown(model, {
        preparedAtDisplay: "Synthetic precision proof",
        bundleId: "export-precision",
        sourceReports: [model.baseline, model.later],
    });
    const patternLine = markdown.split("\n").find(line => line.startsWith("| Mail / workiq-fetch"));
    assert.ok(patternLine.includes("0.01"), `Tiny measured change was lost: ${patternLine}`);
    assert.doesNotMatch(patternLine, /\| -?0\.0 \|/);
});
