import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { selectReportPopulation, freezeReportPopulation, validateReportPopulation, normalizeReportFocus, resolveReportView } from "../lib/report-population.mjs";
import { reportContextRef } from "../lib/report-ref.mjs";

const key = "a".repeat(64);
const options = (outcome = "all", services = []) => ({
    reportFocus: { version: 1, preset: outcome, outcome, services },
    dateSelection: { range: "custom", from: "2026-11-02", to: "2026-11-08" },
    timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" },
});
function record(id, outcome = "success", startedAt = "2026-11-04T20:00:00Z") {
    const value = fixture(id);
    value.capturedAt = startedAt;
    Object.assign(value.toolCalls[0], {
        startedAt, toolSucceeded: outcome === "unknown" ? null : outcome === "success",
        reportedOutcome: outcome === "unknown" ? "unknown" : outcome === "success" ? "succeeded" : "failed",
        apiResults: [{ index: 0, statusCode: outcome === "unknown" ? null : outcome === "success" ? 200 : 503 }],
    });
    return value;
}
const project = (records, settings) => selectReportPopulation(buildExportCatalog(records).records, settings);

test("failure reports keep mixed interactions and freeze the larger reference population without its prompt text", () => {
    const mixed = record("mixed", "failure"), complete = record("complete"), unknown = record("unknown", "unknown");
    mixed.toolCalls.push(record("mixed-complete").toolCalls[0]);
    const value = project([mixed, complete, unknown, record("old", "failure", "2026-10-01T10:00:00Z")], options("errors"));
    assert.deepEqual(value.records.map(record => record.scenarioId), ["mixed"]);
    assert.equal(value.records[0].toolCalls.length, 2);
    assert.equal(value.reference.length, 3);
    const frozen = freezeReportPopulation(value, key);
    assert.equal(frozen.reference.filter(entry => entry.hasError).length, 1);
    assert.equal(frozen.reference.filter(entry => entry.hasUnknownCalls).length, 1);
    assert.equal(JSON.stringify(frozen).includes("SYNTHETIC_PRIVATE"), false);
    assert.deepEqual(frozen.included, [reportContextRef(key, "scenario", "mixed")]);
    assert.throws(() => validateReportPopulation({ ...frozen, included: [] }), /population/);
    assert.throws(() => validateReportPopulation(frozen, [{ scenarioId: reportContextRef(key, "scenario", "complete") }]), /population/);
});

test("completed calls with a returned API error are failures, not completed-only interactions", () => {
    const returnedError = record("returned-error");
    returnedError.toolCalls[0].apiResults[0].statusCode = 403;
    const unknown = record("unknown", "unknown"), complete = record("complete");
    assert.deepEqual(project([returnedError, unknown, complete], options("errors")).records.map(record => record.scenarioId), ["returned-error"]);
    assert.deepEqual(project([returnedError, unknown, complete], options("completed")).records.map(record => record.scenarioId), ["complete"]);
});

test("either conflicting returned status can retain error membership without changing the completed call", () => {
    for (const [reported, diagnostic, hasError] of [
        [200, 500, true], [500, 200, true], [403, 500, true], [299, 400, true], [200, 599, true],
        [200, 201, false], [301, 302, false], [200, 399, false],
    ]) {
        const value = record(`conflict-${reported}-${diagnostic}`);
        value.toolCalls[0].apiResults = [{ index: 0, statusCode: reported,
            errorDiagnostic: { version: 1, source: "result-error", status: "recorded", statusCode: diagnostic,
                message: hasError ? "The response processor failed." : "The response statuses differ." } }];
        const before = structuredClone(value);
        const errors = project([value], options("errors")), completed = project([value], options("completed"));
        assert.equal(errors.records.length, hasError ? 1 : 0, `${reported}/${diagnostic}: Errors membership`);
        assert.equal(completed.records.length, hasError ? 0 : 1, `${reported}/${diagnostic}: Completed membership`);
        assert.equal(errors.reference[0].hasError, hasError);
        assert.equal(errors.reference[0].completedCallsOnly, !hasError);
        assert.equal(value.toolCalls[0].reportedOutcome, "succeeded");
        assert.equal(value.toolCalls[0].apiResults[0].statusCode, reported);
        assert.deepEqual(value, before);
    }
    const oldSource = record("legacy-completed");
    oldSource.toolCalls[0].apiResults = [{ index: 0, statusCode: 200,
        errorDiagnostic: { version: 1, source: "result-error", status: "recorded", statusCode: 500 } }];
    const legacy = freezeReportPopulation(project([oldSource], options("completed")), key);
    Object.assign(legacy.reference[0], { hasError: false, completedCallsOnly: true });
    legacy.included = legacy.reference.map(entry => entry.ref);
    const bytes = JSON.stringify(legacy);
    assert.equal(validateReportPopulation(legacy).reference[0].hasError, false);
    assert.equal(JSON.stringify(legacy), bytes, "Saved population flags are read, not recomputed from later source facts.");
});

test("an empty or withheld field is not itself a failure, while explicit application errors qualify", () => {
    const empty = record("empty-code");
    empty.toolCalls[0].apiResults = [{ index: 0, statusCode: null, errorCode: "" }];
    const application = record("application-error");
    application.toolCalls[0].resultEvidence = { version: 1, source: "sdk-result", applicationError: true,
        statusCode: null, resultCount: null, contentStatus: "body-excluded" };
    assert.deepEqual(project([empty, application], options("errors")).records.map(record => record.scenarioId), ["application-error"]);
    assert.deepEqual(project([empty, application], options("completed")).records.map(record => record.scenarioId), ["empty-code"]);
});

test("a dated report uses inclusive civil dates, while undated evidence is not assigned to the period", () => {
    const first = record("first", "success", "2026-11-02T08:00:00Z");
    const last = record("last", "success", "2026-11-09T07:59:59Z");
    const after = record("after", "success", "2026-11-09T08:00:00Z");
    const undated = record("undated", "unknown", null);
    const value = project([first, last, after, undated], options());
    assert.deepEqual(value.records.map(record => record.scenarioId), ["first", "last"]);
    assert.equal(value.undatedInteractions, 1);
    assert.equal(value.reference.length, 2);
});

test("service filtering and canonical aliases never use the page or silently duplicate interactions", () => {
    const calendar = record("calendar"), mail = record("mail");
    mail.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
    mail.toolCalls[0].requestedApiPath = "/me/messages";
    const duplicate = { ...structuredClone(mail), scenarioId: "mail-alias", isLegacy: true };
    const value = project([calendar, mail, duplicate], options("all", ["Mail"]));
    assert.deepEqual(value.records.map(record => record.scenarioId), ["mail"]);
    assert.equal(value.reference.length, 1);
});

test("invalid focus options and native conversation inference fail closed", () => {
    assert.throws(() => normalizeReportFocus({ ...options().reportFocus, services: ["invented"] }), /supported report/);
    assert.throws(() => normalizeReportFocus({ ...options().reportFocus, extra: true }), /supported report/);
    assert.throws(() => selectReportPopulation([{ scenarioId: "native", recordKind: "native-conversation" }], options()), /qualified interaction/);
});

test("Current date replacement preserves services and accepts only resolved Search membership", () => {
    const old = record("old", "failure", "2026-10-28T20:00:00Z"), recent = record("recent"), outside = record("calendar");
    for (const value of [old, recent]) {
        value.toolCalls[0].requestedApiPath = "/me/messages";
        value.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
    }
    const input = { analytics: { layer: "tool", filters: { scope: "all", services: ["Mail"], from: "2026-11-02", to: "2026-11-08" } },
        withinServices: [], semanticSelection: { receipt: { opaque: true } } };
    const setting = { ...options(), dateSelection: { range: "14", from: "2026-10-26", to: "2026-11-08" } };
    assert.deepEqual(resolveReportView([old, recent, outside], input, setting,
        () => ({ scenarioIds: ["old", "calendar"], actionIds: [], parentScenarioIds: [] })), ["old"]);
    assert.throws(() => resolveReportView([old, recent], input, setting), /Search membership/);
    assert.throws(() => resolveReportView([old, recent], input, setting, () => { throw new Error("stale-search-membership"); }), /stale-search/);
    assert.deepEqual(input.analytics.filters, { scope: "all", services: ["Mail"], from: "2026-11-02", to: "2026-11-08" });
});
