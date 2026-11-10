import test from "node:test";
import assert from "node:assert/strict";
import { projectReportResultObservation, freezeReportResultFacts, validateReportResultFacts,
    summarizeReportResultFacts, compareReportResultFacts } from "../lib/report-result-facts.mjs";
import { projectReportResults } from "../lib/report-result-projection.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { fixture } from "./helpers.mjs";
import { reportResultContent, reportResultHtml, reportResultMarkdown } from "../lib/report-result-output.mjs";

const namespace = "namespace-" + "a".repeat(32);
const recordRef = "record-" + "b".repeat(32);
const observationRef = "result-observation-" + "c".repeat(16);
function facts(flag, overrides = {}) {
    return freezeReportResultFacts([{ ref: recordRef, source: "github-copilot", tool: "workiq-fetch", completion: "succeeded",
        observations: [projectReportResultObservation(observationRef, { resultEvidence: flag === undefined ? undefined : {
            version: 1, source: "sdk-result", applicationError: flag, statusCode: null,
            contentStatus: "body-excluded", resultCount: null, ...overrides,
        }, retainedResultCount: 0 })] }], namespace);
}

test("human report output includes every call and the precise missing-error gap beyond twelve calls", () => {
    const value = freezeReportResultFacts(Array.from({ length: 15 }, (_, index) => ({
        ref: "record-" + (index + 1).toString(16).padStart(32, "0"), source: "github-copilot",
        tool: "workiq-fetch", completion: index === 14 ? "succeeded" : "failed",
        observations: [projectReportResultObservation("result-observation-" + (index + 1).toString(16).padStart(32, "0"),
            index === 13 ? { diagnostic: { version: 1, source: "completion-error", status: "sensitive-excluded", code: "AccessDenied" } } : {})],
    })), namespace);
    const content = reportResultContent(value);
    assert.equal(content.calls.length, 15);
    assert.equal(content.omittedCalls, 0);
    for (const text of [reportResultHtml(value), reportResultMarkdown(value).join("\n")]) {
        assert.match(text, /Report call 15/);
        assert.match(text, /Failure reason was not saved/);
        assert.match(text, /excluded for privacy/);
        assert.match(text, /does not establish answer correctness or overall task success/);
        assert.doesNotMatch(text, /manifest lists .*more calls/);
    }
});

test("result-level change is independent of unchanged completion and never inferred from it", () => {
    const before = facts(false), after = facts(true), comparison = compareReportResultFacts(before, after);
    assert.equal(comparison.groups[0].baseline.completions, 1);
    assert.equal(comparison.groups[0].later.completions, 1);
    assert.equal(comparison.groups[0].applicationErrorDelta, 100);
    assert.equal(summarizeReportResultFacts(facts(null))[0].application.errors, null);
});

test("SDK projection binds the existing frozen canonical membership and resolves each original call", () => {
    const record = fixture("result-facts"), state = { revision: 1, pseudonymKey: "a".repeat(64) };
    record.toolCalls[0].resultEvidence = { version: 1, source: "sdk-result", applicationError: true,
        statusCode: null, resultCount: null, contentStatus: "body-excluded" };
    const githubFacts = buildReportFacts([record], state).facts;
    const projected = projectReportResults([record], state.pseudonymKey, { githubFacts });
    assert.equal(projected.facts.calls[0].observations[0].applicationError, true);
    assert.deepEqual(projected.facts.calls.map(call => call.ref),
        githubFacts.memberships.flatMap(group => group.members.filter(member => member.kind === "tool-call").map(member => member.ref)));
    assert.equal(projected.sources[0].memberRef, projected.facts.calls[0].ref);
    const reading = reportResultContent(projected.facts, githubFacts);
    assert.ok(reading.calls[0].lines.some(line => line.startsWith("Requested: ")));
    assert.throws(() => reportResultContent({ ...projected.facts, namespace: "namespace-" + "e".repeat(32) }, githubFacts),
        /different report namespace/);
});

test("old missing result facts and partial flag coverage remain unavailable, not zero", () => {
    assert.equal(compareReportResultFacts(undefined, facts(true)).reason, "baseline-result-facts-not-saved");
    const summary = summarizeReportResultFacts(facts(undefined))[0];
    assert.equal(summary.application.errors, null);
    assert.equal(summary.resultUnavailable, 1);
    assert.equal(compareReportResultFacts(facts(undefined), facts(true)).groups[0].applicationErrorDelta, null);
    assert.equal(compareReportResultFacts(facts(null), facts(false)).groups[0].reason, "application-result-coverage-incomplete");
});

test("conflicting observation variants do not become extra calls or a latest-only verdict", () => {
    const record = facts(true);
    record.calls[0].observations.push(projectReportResultObservation("result-observation-" + "d".repeat(16),
        { resultEvidence: { version: 1, source: "sdk-result", applicationError: false,
            statusCode: null, contentStatus: "body-excluded", resultCount: null }, retainedResultCount: 0 }));
    const summary = summarizeReportResultFacts(record)[0];
    assert.equal(summary.calls, 1);
    assert.equal(summary.application.known, 0);
    assert.equal(summary.application.conflicting, 1);
    assert.equal(compareReportResultFacts(facts(false), record).groups[0].applicationErrorDelta, null);
});

test("safe typed projection excludes prose, private codes and arbitrary fields while retaining exact membership", () => {
    const record = facts(true, { diagnostic: { version: 1, source: "mcp-result-text", status: "recorded",
        code: "CustomTenantSpecificCode", message: "EXCLUDED_PROSE" },
    description: { version: 1, status: "recorded", text: "EXCLUDED_DESCRIPTION" } });
    assert.doesNotMatch(JSON.stringify(record), /EXCLUDED_|CustomTenant/);
    assert.equal(record.calls[0].observations[0].errorCodeStatus, "withheld");
    assert.doesNotThrow(() => validateReportResultFacts(record, { memberRefs: [recordRef] }));
    assert.throws(() => validateReportResultFacts(record, { memberRefs: [] }), /Invalid frozen result/);
    const unexpected = structuredClone(record); unexpected.calls[0].body = "EXCLUDED_BODY";
    assert.throws(() => validateReportResultFacts(unexpected), /Invalid frozen result/);
    assert.throws(() => projectReportResultObservation(observationRef, { resultEvidence: { version: 2 } }), /Unsupported retained result/);
    const legacy = projectReportResultObservation(observationRef, { legacyFailure: {
        version: 1, reason: "error-code-recorded", code: "AccessDenied", messageStatus: "text-excluded",
    } });
    assert.equal(legacy.errorCode, "AccessDenied");
    assert.equal(legacy.errorCodeBasis, "retained-failure-projection");
    assert.equal(legacy.diagnosticStatus, "not-retained");
    assert.equal(legacy.resultVersion, null);
});

test("capped coverage, source populations and namespace changes stay explicit", () => {
    const record = facts(true, { resultCount: 102 });
    record.calls[0].observations[0].retainedResultCount = 100;
    assert.equal(summarizeReportResultFacts(record)[0].cappedCalls, 1);
    const anotherNamespace = { ...facts(false), namespace: "namespace-" + "e".repeat(32) };
    assert.equal(compareReportResultFacts(record, anotherNamespace).groups[0].reason, "source-namespace-differs");
    const native = freezeReportResultFacts([{ ref: "native-call-" + "f".repeat(16), source: "microsoft-365-cowork",
        tool: null, completion: "succeeded", observations: [projectReportResultObservation("native-observation-" + "1".repeat(16), {
            resultEvidence: { version: 1, source: "native-tool-result", applicationError: null, statusCode: null,
                resultCount: null, contentStatus: "unsupported-format" },
        })] }], namespace);
    const comparison = compareReportResultFacts(record, native);
    assert.equal(comparison.groups.length, 2);
    assert.ok(comparison.groups.every(group => group.reason === "source-population-missing" && group.applicationErrorDelta === null));
});

test("native returned-entry positions retain their source indexes independently of the retained-count cap", () => {
    const value = freezeReportResultFacts([{ ref: "native-call-" + "f".repeat(16), source: "microsoft-365-cowork",
        tool: null, completion: "succeeded", observations: [projectReportResultObservation("native-observation-" + "1".repeat(16), {
            retainedResultCount: 1, returnedEntries: [{ index: 120, statusCode: 200, errorCode: null }],
        })] }], namespace);
    assert.equal(value.calls[0].observations[0].returnedEntries[0].index, 120);
    assert.equal(value.calls[0].observations[0].resultCount, null);
});
