import test from "node:test";
import assert from "node:assert/strict";
import { makeSnapshot, makeRatio, makeDuration, id } from "./report-comparison-fixtures.mjs";
import { evaluationSummaryHtml, evaluationSummaryMarkdown } from "../lib/report-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { fixture } from "./helpers.mjs";

test("readable reports explain unsupported checks and timing instead of exposing reason codes", () => {
    const records = [fixture("readable-reasons")];
    const { facts } = buildReportFacts(records, { revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] });
    for (const text of [evaluationSummaryHtml(facts), evaluationSummaryMarkdown(facts).join("\n")]) {
        assert.match(text, /Local observations do not assess answer correctness/);
        assert.match(text, /No verified request-to-final-answer timing/);
        assert.match(text, /0 of 1 assessed/);
        assert.doesNotMatch(text, /Unavailable: unverified-association|unsupported-check|no-assessed-units/);
    }
});

test("personal zero pass share and measured zero milliseconds remain actual zero values", () => {
    const facts = makeSnapshot(), rating = makeRatio(0, 1);
    Object.assign(rating, {
        dimension: "accuracy", checkId: "semantic-answer-correctness", origin: "user-personal",
        eligibleUnitRefs: [id("interaction")], coveredUnitRefs: [id("interaction")],
    });
    facts.metrics = [rating, { ...makeDuration([0]), metricRef: id("metric", 2) }];
    const html = evaluationSummaryHtml(facts), markdown = evaluationSummaryMarkdown(facts).join("\n");
    assert.match(html, /performance-red">0%/);
    assert.match(html, />0 ms</);
    assert.match(html, /Personal assessment/);
    assert.match(markdown, /\| Accuracy \| Your feedback \| 0% \|/);
    assert.match(markdown, /\| Speed \| Median tool-call duration \| 0 ms \|/);
});

test("percentage formatting never rounds across a performance-color boundary", () => {
    const formatter = createReportComparison();
    assert.equal(formatter.presentation.performanceBands.id, "assessed-pass-share-v1");
    for (const [value, expected] of [[49.999, "49.99%"], [74.995, "74.99%"], [89.999, "89.99%"], [99.999, "99.99%"], [0.001, "<0.01%"], [0, "0%"], [100, "100%"]]) {
        assert.equal(formatter.formatValue(value, "percent"), expected);
    }
    assert.equal(formatter.formatValue(-0.001, "percentage-points"), "−<0.01 pp");
});
