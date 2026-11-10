import test from "node:test";
import assert from "node:assert/strict";
import { projectReportResults } from "../lib/report-result-projection.mjs";
import { reportResultContent } from "../lib/report-result-output.mjs";
import { compareReportResultFacts, validateReportResultFacts } from "../lib/report-result-contract.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { timeoutRecord } from "./timing-outcome-fixture.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { projectReportPatterns, reportPatternError } from "../lib/report-patterns.mjs";
const project = records => projectReportResults(records, "a".repeat(64)).facts;

test("a retained MCP timeout remains an explicit per-call cause in report facts and reading", () => {
    const record = timeoutRecord(), before = structuredClone(record);
    const facts = project([record]), observation = facts.calls[0].observations[0];
    assert.deepEqual(observation.timingFailure, { version: 1, kind: "request-timeout", basis: "retained-failure-signal" });
    assert.equal(observation.errorCode, "failure", "Keep the separate outer failure code.");
    assert.equal(observation.errorTextAvailable, false, "A screened signal is not retained original prose.");
    assert.match(reportResultContent(facts).calls[0].lines.join("\n"), /Request timed out \(MCP -32001\)/);
    const preparedAt = "2026-11-10T12:00:00.000Z";
    const metrics = buildReportFacts([record], { revision: 1, pseudonymKey: "a".repeat(64) }, { preparedAt }).facts;
    const patterns = projectReportPatterns([record], metrics, facts, "a".repeat(64));
    assert.match(reportPatternError(patterns.groups.find(group => group.kind === "errors")), /Request timed out \(MCP -32001\)/);
    const unclassified = structuredClone(record);
    delete unclassified.toolCalls[0].failureEvidence.messageSignal;
    assert.deepEqual(buildReportFacts([unclassified], { revision: 1, pseudonymKey: "a".repeat(64) }, { preparedAt }).facts.metrics, metrics.metrics,
        "Timing samples and canonical populations do not change with explanatory detail.");
    assert.deepEqual(record, before);
});

test("elapsed time, missing completions and unqualified or nonfailure signals do not become timeout causes", () => {
    const records = ["slow-completed", "unknown", "generic-failure", "unscreened", "wrong-version", "different-signal"].map(id => {
        const record = timeoutRecord(id, 195502), call = record.toolCalls[0];
        if (id === "slow-completed") { call.reportedOutcome = "succeeded"; call.toolSucceeded = true; }
        if (id === "unknown") {
            call.reportedOutcome = "unknown"; call.toolSucceeded = null;
            call.completedAt = null; call.completionEventId = null; call.durationMs = null;
        }
        if (id === "generic-failure") delete call.failureEvidence.messageSignal;
        if (id === "unscreened") call.failureEvidence.messageStatus = "sensitive-excluded";
        if (id === "wrong-version") call.failureEvidence.version = 2;
        if (id === "different-signal") call.failureEvidence.messageSignal = "access-denial";
        return record;
    });
    for (const call of project(records).calls) assert.equal(Object.hasOwn(call.observations[0], "timingFailure"), false, call.tool);
    assert.doesNotMatch(JSON.stringify(reportResultContent(project(records))), /timed out|MCP -32001/);
});

test("old frozen facts remain unchanged while Compare describes newly retained timeout evidence", () => {
    const current = project([timeoutRecord()]);
    const old = structuredClone(current);
    delete old.calls[0].observations[0].timingFailure;
    const bytes = JSON.stringify(old);
    validateReportResultFacts(old);
    assert.doesNotMatch(JSON.stringify(reportResultContent(old)), /Request timed out/);
    const comparison = compareReportResultFacts(old, current);
    assert.equal(comparison.shared.changedTypedFacts, 1);
    assert.match(JSON.stringify(createReportComparison().resultComparisonContent(comparison)), /Request timed out \(MCP -32001\)/);
    assert.equal(JSON.stringify(old), bytes);
    for (const change of [
        value => { value.kind = "slow"; },
        value => { value.basis = "elapsed-time"; },
        value => { value.version = 2; },
        value => { value.durationMs = 180024; },
    ]) {
        const invalid = structuredClone(current);
        change(invalid.calls[0].observations[0].timingFailure);
        assert.throws(() => validateReportResultFacts(invalid), /Invalid frozen result facts/);
    }
    const inconsistent = structuredClone(current);
    inconsistent.calls[0].completion = "unknown";
    assert.throws(() => validateReportResultFacts(inconsistent), /Invalid frozen result facts/);
});

test("the observed PolicyUnavailable code is admitted without admitting arbitrary private codes", () => {
    for (const [code, expected] of [["PolicyUnavailable", "PolicyUnavailable"], ["CustomTenantSpecificCode", null]]) {
        const record = timeoutRecord();
        record.toolCalls[0].failureEvidence = { version: 1, reason: "error-code-recorded", code,
            messageStatus: "text-excluded", messageSignal: null,
            diagnostic: { version: 1, source: "workiq-error-json", status: "recorded", code } };
        const observation = project([record]).calls[0].observations[0];
        assert.equal(observation.errorCode, expected);
        assert.equal(observation.errorCodeStatus, expected === null ? "withheld" : "recorded");
        assert.equal(observation.timingFailure, undefined);
    }
});
