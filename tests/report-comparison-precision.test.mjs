import test from "node:test";
import assert from "node:assert/strict";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonMarkdown, comparisonBodyHtml } from "../lib/report-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createTimingPresentation } from "../web/assessment-presentation.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { renderPeriodReportHtml, renderPeriodReportMarkdown } from "../lib/period-report-output.mjs";

const timing = createTimingPresentation(undefined, { compact: true });
const signedCases = [
    [-11850, "\u221211,850 ms (\u221211.85 s)"],
    [11850, "+11,850 ms (+11.85 s)"],
    [-325, "\u2212325 ms"], [325, "+325 ms"], [0, "0 ms"],
];

test("signed comparison equivalents preserve direction without accepting negative measured durations", () => {
    const formatter = createReportComparison(undefined, timing.duration);
    assert.equal(formatter.formatValue(-11850, "ms"), "\u221211,850 ms (\u221211.85 s)");
    for (const [value, expected] of signedCases) assert.equal(formatter.formatChange(value, "ms"), expected);
    assert.equal(formatter.formatValue(11850, "ms"), "11,850 ms (11.85 s)");
    assert.equal(formatter.formatChange(-0, "ms"), "0 ms");
    assert.equal(timing.duration(null), "Not measured");
    for (const value of [-1, NaN, Infinity, undefined]) assert.throws(() => timing.duration(value), TypeError);
    for (const value of [null, NaN, Infinity]) assert.throws(() => formatter.formatChange(value, "ms"), TypeError);
    assert.equal(createReportComparison().formatValue(-11850, "ms"), "-11.85 s", "Historical format stays unchanged");
});

test("v3 comparison and period report deltas preserve both signs without changing frozen values or v2 rendering", () => {
    for (const [difference, expected] of signedCases) {
        const base = 12000, later = base + difference;
        const report = (id, value) => ({
            schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true,
            patternVersion: 1, toolRows: [], patterns: [],
            metrics: [{ metric: "speed", kind: "duration", definitionId: "tool-duration", definitionVersion: 1,
                unit: "ms", basis: "observed", aggregation: "median", boundary: "tool-start-to-completion",
                state: "available", value, coverage: { count: 1, eligible: 1 } }],
            scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic", callTimesAvailable: false, historyComplete: false },
        });
        const model = compareFrozenReportFacts(report("a", base), report("b", later));
        const snapshot = { presentation: { schemaVersion: 3 }, preparedAtDisplay: "Invented sign proof", sourceReports: [model.baseline, model.later] };
        const before = JSON.stringify(model);
        const html = comparisonBodyHtml(model, snapshot), markdown = renderComparisonMarkdown(model, snapshot);
        assert.ok(html.includes(difference === 0 ? "Unchanged" : expected), "comparison HTML: " + expected);
        assert.ok(markdown.includes(expected), "comparison Markdown: " + expected);
        assert.equal(JSON.stringify(model), before);
        const v2 = { ...snapshot, presentation: { schemaVersion: 2 } };
        const legacy = createReportComparison();
        const legacyChange = difference === 0 ? "Unchanged"
            : `${difference < 0 ? "\u2212" : "+"}${legacy.formatValue(Math.abs(difference), "ms")}`;
        assert.ok(comparisonBodyHtml(model, v2).includes(legacyChange), "v2 HTML retains legacy duration wording");
        assert.ok(renderComparisonMarkdown(model, v2).includes(legacy.formatValue(difference, "ms")), "v2 Markdown retains legacy duration wording");

        const { state, input } = periodFixture();
        for (const record of state.evidence) for (const call of record.toolCalls) {
            if (!Number.isFinite(call.durationMs)) continue;
            call.durationMs = Date.parse(call.startedAt) < Date.parse("2026-03-08T05:00:00Z") ? base : later;
            call.completedAt = new Date(Date.parse(call.startedAt) + call.durationMs).toISOString();
        }
        const comparison = buildPeriodComparison(state, input);
        const frozen = freezePeriodReport(state, acceptPeriodReport(state, comparison), "2026-03-11T12:00:00.000Z").frozen;
        const records = [...new Set(Object.values(frozen.periods).flatMap(side => side.scenarioRefs))]
            .map(scenarioId => ({ scenarioId, toolCalls: [], graphActivities: [], httpRecords: [], prompts: [] }));
        const period = { ...snapshot, periodComparison: frozen, records, promptMode: "none" }, serialized = JSON.stringify(period);
        for (const text of [renderPeriodReportHtml(period), renderPeriodReportMarkdown(period)]) {
            assert.ok(text.includes(expected), "period output: " + expected);
        }
        assert.equal(JSON.stringify(period), serialized);
        for (const text of [renderPeriodReportHtml({ ...period, presentation: { schemaVersion: 2 } }),
            renderPeriodReportMarkdown({ ...period, presentation: { schemaVersion: 2 } })]) {
            if (Math.abs(difference) >= 1000) assert.ok(!text.includes(expected), "v2 period output stays unchanged");
        }
    }
});

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
