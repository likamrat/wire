import test from "node:test";
import assert from "node:assert/strict";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport, PERIOD_POPULATION, validatePeriodReport } from "../lib/period-report.mjs";
import * as output from "../lib/period-report-output.mjs";

function snapshotFixture(periods) {
    const { state, input } = periodFixture();
    const value = buildPeriodComparison(state, periods ? { ...input, periods } : input);
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), "2026-03-11T12:00:00.000Z").frozen;
    const records = [...new Set(Object.values(frozen.periods).flatMap(side => side.scenarioRefs))]
        .map(scenarioId => ({ scenarioId, toolCalls: [], graphActivities: [], httpRecords: [], prompts: [] }));
    return { periodComparison: frozen, records, preparedAtDisplay: "Mar 11, 2026", promptMode: "none" };
}

test("period evidence groups preserve record order and qualify common fields independently", () => {
    const snapshot = snapshotFixture(), side = snapshot.periodComparison.periods.baseline;
    const scenarioRef = side.rows[0].scenarioRef;
    side.rows = side.rows.map((row, index) => ({ ...row, scenarioRef, tool: "workiq-fetch",
        services: [index === 1 ? "Calendar" : "Files"], missingService: false, serviceNotApplicable: false }));
    const before = JSON.stringify(snapshot);
    const groups = output.groupPeriodEvidence(side, snapshot);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].commonTool, "workiq-fetch");
    assert.equal(groups[0].commonService, null);
    assert.deepEqual(groups[0].records.map(record => record.row.id), side.rows.map(row => row.id));
    assert.deepEqual(groups[0].records.map(record => record.ordinal), [1, 2, 3]);
    assert.equal(JSON.stringify(snapshot), before);
});

test("current period HTML presents validated visuals and grouped evidence without changing frozen facts", () => {
    const snapshot = snapshotFixture(), before = JSON.stringify(snapshot);
    const html = output.renderPeriodReportHtml(snapshot);
    assert.match(html, /class="comparison-visuals"/);
    assert.match(html, /Grouped by frozen interaction ordinal, not event chronology/);
    for (const side of Object.values(snapshot.periodComparison.periods)) {
        for (const row of side.rows) assert.ok(html.includes(`data-record-id="${row.id}"`));
    }
    assert.match(html, /Scope and coverage/);
    assert.ok(html.includes("Unequal windows: A 1 day; B 2 days."));
    assert.doesNotMatch(html, /design mock|session-state[\\/]/i);
    for (const record of periodFixture().records) for (const call of record.toolCalls) {
        if (call.startedAt) assert.ok(!html.includes(call.startedAt), "Source event timestamps stay withheld");
    }
    assert.equal(JSON.stringify(snapshot), before);
});

test("period volume changes and service context use singular counts without changing frozen values", () => {
    const { baseline, later } = periodFixture().input.periods;
    for (const [periods, change] of [
        [undefined, "+1 record"],
        [{ baseline: later, later: baseline }, "-1 record"],
        [{ baseline, later: baseline }, "0 records"],
    ]) {
        const snapshot = snapshotFixture(periods), before = JSON.stringify(snapshot);
        const html = output.renderPeriodReportHtml(snapshot);
        assert.ok(html.includes(`Volume change: ${change}</p>`), change);
        for (const side of Object.values(snapshot.periodComparison.periods)) {
            const count = side.serviceSelection.contextOnlyRefs.length;
            assert.ok(html.includes(`${count} missing-service context record${count === 1 ? "" : "s"}</dd>`));
        }
        assert.equal(JSON.stringify(snapshot), before);
    }
});

test("service qualifications prevent hoisting and unmapped records never become a common interaction", () => {
    const snapshot = snapshotFixture(), side = snapshot.periodComparison.periods.baseline;
    const scenarioRef = side.rows[0].scenarioRef;
    side.rows = side.rows.map(row => ({ ...row, scenarioRef, tool: "workiq-fetch", services: ["Files"],
        missingService: false, serviceNotApplicable: false }));
    side.rows[1].missingService = true;
    assert.equal(output.groupPeriodEvidence(side, snapshot)[0].commonService, null);
    side.rows = side.rows.map(row => ({ ...row, services: [], missingService: true }));
    assert.deepEqual(output.groupPeriodEvidence(side, snapshot)[0].commonService,
        { services: [], missingService: true, serviceNotApplicable: false });
    side.unmappedScenarioRefs = [scenarioRef];
    const groups = output.groupPeriodEvidence(side, snapshot);
    assert.equal(groups.length, side.rows.length);
    assert.ok(groups.every(group => group.interactionOrdinal === null && group.records.length === 1
        && group.commonTool === null && group.commonService === null));
});

test("single-record groups keep context with their record rather than adding a redundant common-field line", () => {
    const snapshot = snapshotFixture();
    const groups = Object.values(snapshot.periodComparison.periods).flatMap(side => output.groupPeriodEvidence(side, snapshot))
        .filter(group => group.records.length === 1);
    assert.ok(groups.length > 0);
    const html = output.renderPeriodReportHtml(snapshot);
    for (const group of groups) {
        assert.equal(group.commonTool, null);
        assert.equal(group.commonService, null);
        const row = group.records[0].row, start = html.indexOf(`data-record-id="${row.id}"`);
        const record = html.slice(start, html.indexOf("</tr>", start));
        assert.ok(record.includes(row.tool));
        for (const service of row.services) assert.ok(record.includes(service));
    }
});

test("legacy period projections retain their original presentation and current malformed facts are rejected", () => {
    for (const version of [2, 3]) {
        const snapshot = structuredClone(snapshotFixture()), value = snapshot.periodComparison;
        value.definitions.metricProjectionVersion = version;
        value.scope.population = PERIOD_POPULATION;
        value.scope.findings = "Full retained interactions selected by matching records; calls outside the period or filters can remain in these interaction findings and metrics.";
        value.scope.interpretation = "Observed differences only. Unequal periods, shared records, different activity and assessment coverage do not establish causal improvement.";
        Object.values(value.periods).forEach(side => { side.facts.metricProjectionVersion = version; });
        validatePeriodReport(value, snapshot.records);
        const before = JSON.stringify(snapshot), html = output.renderPeriodReportHtml(snapshot);
        assert.ok(!html.includes('class="comparison-visuals"'));
        assert.ok(html.includes("Matching records and full retained interactions; separate populations"));
        assert.equal(JSON.stringify(snapshot), before);
    }
    const bad = snapshotFixture();
    bad.periodComparison.periods.baseline.rows[0].durationMs = 999999;
    assert.throws(() => output.renderPeriodReportHtml(bad), /Period report:/);
});

test("overlapping populations are qualified once beside the report comparison", () => {
    const range = periodFixture().input.periods.baseline;
    const snapshot = snapshotFixture({ baseline: range, later: range });
    const html = output.renderPeriodReportHtml(snapshot);
    assert.ok(html.indexOf("Overlap:") < html.indexOf('class="comparison-visuals"'));
    assert.equal(html.match(/Overlap:/g)?.length, 1);
    assert.ok(html.includes(`${snapshot.periodComparison.periods.baseline.rows.length} matching records`));
    assert.ok(!html.includes("No shared matching records"));
});
