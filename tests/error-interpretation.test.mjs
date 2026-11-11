import test from "node:test";
import assert from "node:assert/strict";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { projectReportResults } from "../lib/report-result-projection.mjs";
import { validateReportResultFacts, compareReportResultFacts } from "../lib/report-result-contract.mjs";
import { reportResultContent } from "../lib/report-result-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { projectReportResultText } from "../lib/report-result-text.mjs";
import { resultTextCoverage } from "../lib/report-result-text-shape.mjs";
import { normalizeReportOptions } from "../lib/prompt-projection.mjs";
import { reportResultHtml } from "../lib/report-result-output.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { readSavedArtifactFile, readSavedComparison } from "../lib/report-artifacts.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";

function errorCall(message, code = "failure", statusCode, source = "completion-error") {
    return { tool: "workiq-fetch", reportedOutcome: "failed", toolSucceeded: false,
        failureEvidence: { version: 1, reason: "error-code-recorded", code, messageStatus: "text-excluded",
            diagnostic: { version: 1, source, status: "recorded", ...(message ? { message } : {}), code,
                ...(statusCode === undefined ? {} : { statusCode }) } }, apiResults: [] };
}
const results = createRecordedResults({ screen: true });
const explain = call => results.interpretation(call, call.reportedOutcome === "failed" ? "failure" : "unknown");

test("timeout interpretation requires recorded timeout evidence, never a numeric code or elapsed time alone", () => {
    const timeout = errorCall("MCP server 'workiq': MCP error -32001: Request timed out");
    const value = explain(timeout);
    assert.match(JSON.stringify(value), /allowed waiting interval/);
    assert.match(JSON.stringify(value), /does not identify.*delay/);
    assert.match(JSON.stringify(value), /whether.*work finished/);
    assert.doesNotMatch(JSON.stringify(value), /Next evidence|Check the|Inspect the|Compare the sender/);
    assert.doesNotMatch(JSON.stringify(value), /retry|180000|server was slow/i);
    assert.ok(results.callReasonItems(timeout, "failure").some(item => item.label === "WIRE interpretation"));
    const codeOnly = explain(errorCall(undefined, -32001));
    assert.doesNotMatch(JSON.stringify(codeOnly), /allowed waiting interval/);
    assert.match(JSON.stringify(codeOnly), /no verified meaning/);
    assert.equal(explain({ reportedOutcome: "unknown", durationMs: 900000 }).items[0].kind, "missing-completion");
    const legacy = { failureEvidence: { version: 1, messageStatus: "text-excluded", messageSignal: "request-timeout" } };
    assert.equal(results.interpretation(legacy, "failure").items[0].kind, "request-timeout");
    assert.equal(results.interpretation(legacy, "success").items.length, 0);
    for (const message of ["No MCP error -32001: Request timed out", "Possibly MCP error -32001: Request timed out",
        "MCP error -32001: Request timed out was ruled out"]) {
        assert.doesNotMatch(JSON.stringify(explain(errorCall(message))), /allowed waiting interval/);
    }
});

test("specific upstream evidence explains the failed stage without assigning a downstream API or hidden duration", () => {
    const call = errorCall("MCP server 'workiq': MCP request failed: Transport send error: Transport [InventedTransport] error: unexpected server response: HTTP 503 Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection timeout");
    const value = explain(call);
    assert.equal(value.items[0].kind, "upstream-connection-timeout");
    assert.match(value.items[0].text, /before response headers/);
    assert.match(value.items[0].text, /which upstream service/);
    assert.equal(value.items.length, 1);
    assert.equal(explain(errorCall(undefined, "failure", 503)).items[0].kind, "http-503");
    assert.doesNotMatch(JSON.stringify(explain(errorCall(undefined, "failure", 503))), /connection timed out|maintenance caused/);
});

test("short access and invalid-request errors gain meaning while self-explanatory messages remain intact", () => {
    assert.match(JSON.stringify(explain(errorCall("Access denied", "AccessDenied", 403))), /refused.*request/);
    assert.match(JSON.stringify(explain(errorCall("Bad request", "BadRequest", 400))), /which input/);
    const simple = errorCall("The field 'title' is required. Supply a non-empty title.", "BadRequest", 400);
    assert.deepEqual(explain(simple).items, []);
    assert.ok(results.callReasonItems(simple, "failure").some(item => item.text.includes("non-empty title")));
    const policy = errorCall("The required policy is unavailable.", "PolicyUnavailable", undefined, "workiq-error-json");
    assert.match(JSON.stringify(explain(policy)), /policy.*configuration/);
    assert.equal(explain({ ...policy, failureEvidence: { ...policy.failureEvidence,
        diagnostic: { ...policy.failureEvidence.diagnostic, source: "completion-error" } } }).items.length, 0);
    const explicit = errorCall("Access denied because the calling app lacks the required Mail.Read permission.", "AccessDenied", 403);
    explicit.failureEvidence.messageSignal = "access-denial";
    assert.deepEqual(explain(explicit).items, [], "Specific permission evidence must not acquire a claim that no permission was identified.");
});

test("returned errors, partial coverage, conflicting facts and diagnostic gaps keep their own scope", () => {
    const call = { reportedOutcome: "succeeded", toolSucceeded: true,
        resultEvidence: { version: 1, source: "sdk-result", contentStatus: "partial", applicationError: null,
            statusCode: null, resultCount: null },
        apiResults: [{ index: 4, statusCode: 403, errorCode: "AccessDenied" }] };
    const value = results.interpretation(call, "success");
    assert.ok(value.items.some(item => item.channel === "returned-entry" && item.entryIndex === 4));
    assert.ok(value.items.some(item => item.kind === "partial-evidence"));
    assert.doesNotMatch(value.items.find(item => item.kind === "partial-evidence").text, /call's failure/);
    call.apiResults.push({ ...call.apiResults[0], index: 9 });
    const grouped = results.interpretationItems(results.interpretation(call, "success"));
    assert.ok(grouped.some(item => item.label === "WIRE interpretation (returned entries 5, 10)"));
    assert.doesNotMatch(JSON.stringify(value), /all.*failed|parent.*failed/);
    const privateCall = errorCall("PRIVATE_TEXT", "PRIVATE_CODE");
    privateCall.failureEvidence.diagnostic.status = "sensitive-excluded";
    assert.doesNotMatch(JSON.stringify(explain(privateCall)), /PRIVATE_/);
    assert.deepEqual(explain(privateCall).items, []);
    const stopped = { failureEvidence: { version: 1, messageStatus: "text-excluded",
        messageSource: "workiq-error-json", messageSignal: "retrieval-stopped-error" } };
    assert.match(JSON.stringify(results.interpretation(stopped, "failure")), /no failing sub-operation or cause/);
    assert.doesNotMatch(JSON.stringify(results.interpretation(stopped, "failure")), /allowed waiting interval/);
    assert.match(JSON.stringify(results.interpretation({}, "failure")), /error details are missing/);
});

test("new frozen interpretations carry readable text, retain original facts and never enrich old reports", () => {
    const record = fixture("interpretation");
    Object.assign(record.toolCalls[0], errorCall("MCP server 'workiq': MCP error -32001: Request timed out"));
    const original = structuredClone(record), facts = projectReportResults([record], "a".repeat(64)).facts;
    const observed = facts.calls[0].observations[0];
    assert.equal(observed.interpretation.version, 2);
    assert.match(observed.interpretation.items[0].text, /allowed waiting interval/);
    assert.equal(observed.errorCode, "failure");
    assert.deepEqual(record, original);
    assert.match(JSON.stringify(reportResultContent(facts)), /WIRE interpretation.*allowed waiting interval/);
    const old = structuredClone(facts); delete old.calls[0].observations[0].interpretation;
    const bytes = JSON.stringify(old);
    assert.doesNotMatch(JSON.stringify(reportResultContent(old)), /allowed waiting interval/);
    const comparison = compareReportResultFacts(old, facts);
    assert.equal(comparison.shared.changedTypedFacts, 0);
    assert.equal(comparison.shared.changedInterpretations, 1);
    assert.match(JSON.stringify(createReportComparison().resultComparisonContent(comparison)), /WIRE interpretation.*allowed waiting interval/);
    assert.equal(JSON.stringify(old), bytes);
    for (const change of [
        value => { value.version = 3; },
        value => { value.items[0].text = "The server was slow."; },
        value => { value.items[0].entryIndex = 17; },
        value => { value.items[0].privateBody = "private"; },
    ]) {
        const changed = structuredClone(facts); change(changed.calls[0].observations[0].interpretation);
        assert.throws(() => validateReportResultFacts(changed), /interpretation|frozen result/i);
    }
});

test("incident reading uses only selected diagnostic copies, never omitted prompts, arguments or edited-away wording", () => {
    const record = fixture("copy-boundary");
    record.userPrompt.text = "OMITTED_PROMPT";
    record.toolCalls[0].requestArgs = { query: "PRIVATE_ARGUMENT" };
    Object.assign(record.toolCalls[0], errorCall("MCP server 'workiq': MCP error -32001: Request timed out"));
    const projection = projectReportResults([record], "a".repeat(64));
    const selected = projectReportResultText(projection, "a".repeat(64), normalizeReportOptions({ resultText: true })).frozen;
    const html = reportResultHtml(projection.facts, selected);
    assert.match(html, /Recorded error \(masked report copy\)/);
    assert.equal((html.match(/MCP server/g) ?? []).length, 1, "The selected source diagnostic stays beside its call without an annex duplicate.");
    assert.doesNotMatch(html, /OMITTED_PROMPT|PRIVATE_ARGUMENT/);
    assert.doesNotMatch(reportResultHtml(projection.facts), /MCP server/);
    const edited = structuredClone(selected), copy = edited.copies.find(copy => copy.kind === "error-message");
    copy.text = "Edited diagnostic copy."; copy.representation = "edited-copy";
    edited.coverage = resultTextCoverage(edited.copies);
    const updated = reportResultHtml(projection.facts, edited);
    assert.match(updated, /edited report copy.*Edited diagnostic copy/);
    assert.doesNotMatch(updated, /MCP server/);
    copy.text = null; copy.omitted = true; copy.representation = "omitted";
    edited.coverage = resultTextCoverage(edited.copies);
    assert.doesNotMatch(reportResultHtml(projection.facts, edited), /Edited diagnostic|MCP server/);
    assert.match(reportResultHtml(projection.facts, edited), /allowed waiting interval/);
});

test("conflicting returned and diagnostic statuses stay ambiguous at the exact entry", () => {
    const record = fixture("conflicting-entry");
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 500, errorCode: "AccessDenied",
        errorDiagnostic: { version: 1, source: "result-error", status: "recorded",
            statusCode: 403, code: "AccessDenied", message: "Access denied" } }];
    const call = record.toolCalls[0], before = structuredClone(record);
    const interpretation = results.interpretation(call, "success");
    assert.deepEqual(interpretation.items.map(item => [item.kind, item.channel, item.entryIndex]),
        [["conflicting-status", "returned-entry", 0]]);
    assert.doesNotMatch(JSON.stringify(interpretation), /understood but refused|internal error while handling/);
    const reason = JSON.stringify(results.callReasonItems(call, "success"));
    assert.match(reason, /status 403/); assert.match(reason, /returned status 500/);
    const facts = projectReportResults([record], "a".repeat(64)).facts;
    const entry = facts.calls[0].observations[0].returnedEntries[0];
    assert.equal(entry.statusCode, 500);
    assert.deepEqual(entry.statusConflict, { version: 1, reported: 500, diagnostic: 403 });
    assert.equal(facts.calls[0].completion, "succeeded");
    assert.match(JSON.stringify(reportResultContent(facts)), /diagnostic status 403/i);
    const prior = structuredClone(facts);
    delete prior.calls[0].observations[0].interpretation;
    delete prior.calls[0].observations[0].returnedEntries[0].statusConflict;
    const priorBytes = JSON.stringify(prior);
    const compared = createReportComparison().resultComparisonContent(compareReportResultFacts(prior, facts));
    assert.match(JSON.stringify(compared), /diagnostic status 403/i);
    assert.match(JSON.stringify(compared), /statuses disagree/);
    assert.equal(JSON.stringify(prior), priorBytes);
    assert.deepEqual(record, before);
    for (const change of [
        value => { value.reported = 403; },
        value => { value.diagnostic = 500; },
        value => { value.diagnostic = 99; },
    ]) {
        const invalid = structuredClone(facts);
        change(invalid.calls[0].observations[0].returnedEntries[0].statusConflict);
        assert.throws(() => validateReportResultFacts(invalid), /frozen result/i);
    }
    const falseConclusion = structuredClone(facts);
    falseConclusion.calls[0].observations[0].interpretation = results.interpretation(errorCall("Access denied", "AccessDenied", 403), "failure");
    Object.assign(falseConclusion.calls[0].observations[0].interpretation.items[0], { channel: "returned-entry", entryIndex: 0 });
    assert.throws(() => validateReportResultFacts(falseConclusion), /frozen result/i);
    for (const status of ["redacted", "sensitive-excluded", "size-excluded"]) {
        const limited = structuredClone(record);
        limited.toolCalls[0].apiResults[0].errorDiagnostic.status = status;
        delete limited.toolCalls[0].apiResults[0].errorDiagnostic.message;
        const projected = projectReportResults([limited], "a".repeat(64)).facts;
        assert.equal(projected.calls[0].observations[0].interpretation.items[0].kind, "conflicting-status");
        assert.deepEqual(projected.calls[0].observations[0].returnedEntries[0].statusConflict, entry.statusConflict);
    }
});

test("specific processing and other-channel details cannot acquire record-wide absence claims", () => {
    const call = errorCall("Error while processing response.", "InternalServerError", undefined, "workiq-error-json");
    Object.assign(call.failureEvidence, { messageSource: "workiq-error-json", messageSignal: "response-processing-error" });
    const detail = { code: "InvalidResponse", message: "JSON parsing failed in the response adapter." };
    call.failureEvidence.diagnostic.details = [detail];
    const before = structuredClone(call), explanation = explain(call);
    assert.doesNotMatch(JSON.stringify(explanation), /The record does not identify the processing step/);
    assert.match(JSON.stringify(results.callReasonItems(call, "failure")), /JSON parsing failed in the response adapter/);
    delete call.failureEvidence.diagnostic.details;
    call.resultEvidence = { version: 1, source: "sdk-result", applicationError: true, statusCode: null,
        resultCount: null, contentStatus: "body-excluded",
        diagnostic: { version: 1, source: "result-error", status: "recorded", ...detail } };
    assert.doesNotMatch(JSON.stringify(explain(call)), /The record does not identify the processing step/);
    assert.match(JSON.stringify(results.callReasonItems(call, "failure")), /JSON parsing failed in the response adapter/);
    const record = fixture("processing-detail"); Object.assign(record.toolCalls[0], before);
    const projection = projectReportResults([record], "a".repeat(64));
    const copies = projectReportResultText(projection, "a".repeat(64), normalizeReportOptions({ resultText: true })).frozen;
    const html = reportResultHtml(projection.facts, copies);
    assert.match(html, /JSON parsing failed in the response adapter/);
    assert.doesNotMatch(html, /The record does not identify the processing step/);
    assert.deepEqual(before.failureEvidence.diagnostic.details, [detail]);
    const old = structuredClone(projection.facts);
    old.calls[0].observations[0].interpretation.version = 1;
    old.calls[0].observations[0].interpretation.items[0].text = "Work IQ reported a failure while processing the response. The record does not identify the processing step or establish that the underlying API operation failed.";
    const oldBytes = JSON.stringify(old), oldHtml = reportResultHtml(old, copies);
    validateReportResultFacts(old);
    assert.match(oldHtml, /The record does not identify the processing step/);
    assert.equal(reportResultHtml(old, copies), oldHtml);
    assert.equal(JSON.stringify(old), oldBytes);
    const changed = compareReportResultFacts(old, projection.facts);
    assert.equal(changed.shared.changedTypedFacts, 0);
    assert.equal(changed.shared.changedInterpretations, 1);
});

test("analogous limitations concern the signal alone when another retained detail identifies the missing fact", () => {
    const upstream = errorCall("MCP server 'workiq': MCP request failed: Transport send error: Transport [InventedTransport] error: unexpected server response: HTTP 503 Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection timeout");
    upstream.failureEvidence.diagnostic.details = [{ message: "The upstream service was the document gateway." }];
    assert.doesNotMatch(JSON.stringify(explain(upstream)), /The record does not identify which upstream service/);
    const access = errorCall(undefined, "AccessDenied");
    access.resultEvidence = { version: 1, source: "sdk-result", applicationError: true, statusCode: null,
        resultCount: null, contentStatus: "body-excluded",
        diagnostic: { version: 1, source: "result-error", status: "recorded", message: "Mail.Read permission was missing." } };
    assert.doesNotMatch(JSON.stringify(explain(access)), /The record does not identify the permission/);
    const limited = errorCall("Too many requests", "TooManyRequests", 429);
    limited.resultEvidence = { ...access.resultEvidence, diagnostic: { ...access.resultEvidence.diagnostic,
        message: "The applicable limit was ten requests per minute." } };
    assert.doesNotMatch(JSON.stringify(explain(limited)), /The record does not establish the applicable limit/);
    for (const call of [upstream, access, limited]) {
        const original = structuredClone(call);
        assert.ok(results.callReasonItems(call, "failure").some(item => !item.interpretation && /gateway|Mail.Read|ten requests/.test(item.text)));
        assert.deepEqual(call, original);
    }
});

test("saved Compare preserves both returned statuses in every format without rewriting its earlier report", { timeout: 30000 }, async t => {
    const record = fixture("saved-conflict");
    record.toolCalls[0].apiResults = [];
    const { context } = await privateFixture(t, [record]), controller = createExportController(context), owner = "conflict-owner";
    async function save() {
        const state = await loadBoardState(context);
        const preview = await controller.preview(owner, undefined, { saveMode: "local", promptMode: "none", formats: ["json"] },
            { kind: "all", revision: state.revision });
        return (await controller.confirm(owner, preview.previewId, true, undefined, {
            localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false },
        })).bundle.bundleId;
    }
    const earlier = await save();
    const original = await readSavedArtifactFile(context, await loadBoardState(context), earlier, "report", "json");
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 500, errorCode: "AccessDenied",
        errorDiagnostic: { version: 1, source: "result-error", status: "recorded", statusCode: 403, code: "AccessDenied", message: "Access denied" } }];
    await replaceEvidence(context, () => ({ records: [record] }));
    const later = await save();
    const preview = await controller.previewComparison(owner, earlier, later, { formats: ["html", "markdown", "json", "pdf"] });
    for (const [name, content] of Object.entries(preview.files)) {
        if (name.endsWith(".json")) {
            const value = JSON.parse(content);
            assert.match(JSON.stringify(value), /"statusConflict":\{"version":1,"reported":500,"diagnostic":403\}/);
            continue;
        }
        const text = name.endsWith(".pdf") ? (await pdfDocumentText(Buffer.from(content.data, "base64"))).content.replace(/\s+/g, " ")
            : String(content).replaceAll("\\", "");
        assert.match(text, /diagnostic status 403 conflicts with returned status 500/);
        assert.match(text, /statuses disagree/);
        assert.doesNotMatch(text, /service understood but refused/);
    }
    await controller.reviewComparison(owner, preview.previewId, true);
    const saved = await controller.confirmComparison(owner, preview.previewId, true);
    const read = await readSavedComparison(context, await loadBoardState(context), saved.bundle.bundleId);
    assert.deepEqual(read.comparison.resultComparison.changes[0].later[0].returnedEntries[0].statusConflict,
        { version: 1, reported: 500, diagnostic: 403 });
    assert.deepEqual((await readSavedArtifactFile(context, await loadBoardState(context), earlier, "report", "json")).bytes, original.bytes);
});
