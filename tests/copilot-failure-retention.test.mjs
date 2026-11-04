import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent } from "../lib/collector.mjs";
import { completeWorkIqCall } from "../lib/history.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { normalizeResultEvidence } from "../lib/result-evidence.mjs";
import { workIqErrorEnvelope } from "../lib/workiq-error-envelope.mjs";

function callFrom(error) {
    const event = { id: "invented-completion", type: "tool.execution_complete",
        timestamp: "2026-11-01T12:00:01.000Z",
        data: { toolCallId: "invented-call", success: false, error } };
    const retained = JSON.parse(JSON.stringify(retainEvent(event, { credentialExclusions: 0 })));
    return { retained, call: completeWorkIqCall({ toolCallId: "invented-call",
        startedAt: "2026-11-01T12:00:00.000Z" }, retained) };
}

test("a large Work IQ batch keeps the small original returned error without retaining successful bodies", () => {
    const message = "The requested operation is not available for this item.";
    const { call, retained } = callFrom({ code: "failure",
        message: `MCP server 'workiq': ${JSON.stringify({ results: [
            { statusCode: 200, data: { text: "EXCLUDED_BODY".repeat(2000) } },
            { statusCode: 403, error: { error: { code: "OperationDenied", message,
                details: [{ code: "UnsupportedItem", message: "Choose an item that supports the operation." }],
                innerError: { "request-id": "EXCLUDED_REQUEST_ID" } } } },
        ] })}` });
    assert.deepEqual(call.apiResults.map(result => result.statusCode), [200, 403]);
    assert.equal(call.apiResults[1].errorDiagnostic.message, message);
    assert.equal(call.apiResults[1].errorDiagnostic.details[0].code, "UnsupportedItem");
    assert.match(JSON.stringify(createRecordedResults().diagnosticDetails(call.apiResults[1].errorDiagnostic)), /supports the operation/);
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_/);
    assert.equal(call.toolSucceeded, false);
    assert.equal(call.completionEventId, "invented-completion");
});

test("partial decoding stops before unfinished or ambiguous entries and never mines payloads", () => {
    const good = JSON.stringify({ statusCode: 403, error: { code: "AccessDenied", message: "Editing is not permitted." } });
    for (const message of [
        `MCP server 'workiq': text {"results":[${good}]}`,
        `MCP server 'other': {"results":[${good},`,
        `MCP server 'workiq': {"payload":{"results":[${good},`,
        `MCP server 'workiq': {"results":[{"statusCode":403,"error":{"message":"unfinished`,
        `MCP server 'workiq': {"results":[{"statusCode":403,"error":{"message":"complete error"}]}`,
        `MCP server 'workiq': {"results":[null,${good},`,
        `MCP server 'workiq': {"results":[${good}],"results":[`,
        `MCP server 'workiq': {"results":[{"statusCode":403,"statusCode":404},`,
        `MCP server 'workiq': {"results":[${good}]} trailing {`,
        `MCP server 'workiq': {"results":[{"body":{"error":{"message":"Not a typed returned error."}}},`,
    ]) assert.equal(workIqErrorEnvelope(message), null);
    for (const suffix of [
        ",", ',{"statusCode":500,"error":{"message":"unfinished',
        ',null,{"statusCode":500},', ',{"statusCode":500,"error":{"message":"complete nested field"}',
        "]",
        ',{"statusCode":200,"data":{"text":"EXCLUDED_BODY","text":"duplicate body property"},',
    ]) {
        const { call } = callFrom({ code: "failure", message: `MCP server 'workiq': {"results":[${good}${suffix}` });
        assert.equal(call.apiResults.length, 1);
        assert.equal(call.apiResults[0].errorDiagnostic.message, "Editing is not permitted.");
        assert.equal(call.resultEvidence.contentStatus, "partial");
        assert.equal(call.resultEvidence.resultCount, null);
    }
});

test("inspection, text, entry and privacy bounds stay explicit through partial decoding and reload", () => {
    const good = JSON.stringify({ statusCode: 403, error: { code: "AccessDenied", message: "Editing is not permitted." } });
    const prefix = `MCP server 'workiq': {"results":[${good},`;
    for (const secret of ["Bearer " + "a".repeat(40), "Confidential customer material"]) {
        const { call, retained } = callFrom({ code: "failure", message: prefix + `{"data":"${secret}` });
        assert.deepEqual(call.apiResults, []);
        assert.equal(call.failureEvidence.diagnostic.status, "sensitive-excluded");
        assert.doesNotMatch(JSON.stringify(retained), /Editing is not permitted|Bearer|Confidential/);
    }
    const message = `MCP server 'workiq': ${JSON.stringify({ results: [{ statusCode: 403,
        error: { message: "Editing is not permitted.", details: [{ message: "Contact person@example.invalid." }] } }] })}`;
    const { call } = callFrom({ code: "failure", message });
    assert.equal(call.apiResults[0].errorDiagnostic.status, "redacted");
    assert.equal(call.apiResults[0].errorDiagnostic.details[0].message, "Contact [redacted].");
    for (const [bytes, retained] of [[256000, true], [256001, false]]) {
        const bounded = callFrom({ code: "failure", message: message + " ".repeat(bytes - Buffer.byteLength(message)) }).call;
        assert.equal(bounded.apiResults.length, retained ? 1 : 0);
        if (!retained) assert.equal(bounded.failureEvidence.diagnostic.status, "size-excluded");
    }
    const many = callFrom({ code: "failure",
        message: `MCP server 'workiq': {"results":[${Array.from({ length: 101 }, () => good).join(",")},` }).call;
    assert.equal(many.apiResults.length, 100);
    assert.equal(many.resultEvidence.resultCount, null);
    assert.equal(many.resultEvidence.contentStatus, "partial");
    assert.equal(normalizeResultEvidence({ ...many.resultEvidence, resultCount: 100 }), null);
    const bounded = callFrom({ code: "failure", message: "x".repeat(8193),
        details: [{ code: "EditingDisabled", message: "Enable editing for this item." }] }).call;
    assert.equal(bounded.failureEvidence.diagnostic.status, "size-excluded");
    assert.match(createRecordedResults().failureReason(bounded), /Enable editing for this item/);
    const depth = prefix + '{"data":' + "[".repeat(65);
    assert.equal(workIqErrorEnvelope(depth), null);
});

test("complete returned errors survive a later malformed body with partial coverage and no inferred target", () => {
    const entries = [
        { statusCode: 403, error: { error: { code: "AccessDenied", message: "This item cannot be edited." } } },
        { statusCode: 404, error: { error: { code: "ResourceNotFound", message: "The second returned item was not found." } } },
    ];
    const message = `MCP server 'workiq': {"results":[${entries.map(value => JSON.stringify(value)).join(",")},{"statusCode":200,"data":{"text":"${"EXCLUDED_BODY".repeat(1000)}"]}}`;
    const { call, retained } = callFrom({ code: "failure", message });
    assert.deepEqual(call.apiResults.map(result => [result.index, result.statusCode]), [[0, 403], [1, 404]]);
    assert.equal(call.resultEvidence.contentStatus, "partial");
    assert.equal(call.resultEvidence.resultCount, null);
    assert.equal(call.failureEvidence.code, "failure", "Returned errors do not replace the independent parent marker.");
    assert.equal(call.failureEvidence.messageSignal, null);
    assert.match(createRecordedResults().failureReason(call), /Returned entry 1: This item cannot be edited.*AccessDenied.*403/);
    assert.match(createRecordedResults().failureReason(call), /Returned entry 2: The second returned item was not found/);
    assert.ok(call.apiResults.every(result => !Object.hasOwn(result, "path")));
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_BODY/);
});

test("complete successful entries and ignored body duplicates do not suppress earlier returned errors", () => {
    const error = JSON.stringify({ statusCode: 400, error: { error: { code: "BadRequest", message: "This operation needs an editable item." } } });
    const { call, retained } = callFrom({ code: "failure",
        message: `MCP server 'workiq': {"results":[${error},${error},{"statusCode":200,"data":{"text":"EXCLUDED_FIRST","text":"EXCLUDED_SECOND"}},{"data":{"text":"EXCLUDED_BROKEN"]}}` });
    assert.deepEqual(call.apiResults.map(entry => [entry.index, entry.statusCode]), [[0, 400], [1, 400], [2, 200]]);
    assert.equal(call.resultEvidence.contentStatus, "partial");
    assert.equal(call.resultEvidence.resultCount, null);
    assert.equal(call.apiResults[2].errorDiagnostic, undefined);
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_/);
});
