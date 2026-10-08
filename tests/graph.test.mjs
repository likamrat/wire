import test from "node:test";
import assert from "node:assert/strict";
import { createGraphRecorder, GraphRecordingError, parseGraphJsonMetadata } from "../lib/graph.mjs";

test("Graph recorder forwards once and never persists credentials, query literals or bodies", async () => {
    let sent = 0;
    let captured;
    const recorder = createGraphRecorder({
        enabled: true,
        persist: async (record) => { captured = record; },
        testTransport: async (request) => {
            sent++;
            assert.equal(request.headers.get("authorization"), "Bearer SYNTHETIC_SECRET");
            return new Response(JSON.stringify({ value: ["SYNTHETIC_ENTITY_BODY"] }), {
                status: 200, headers: { "request-id": "11111111-1111-1111-1111-111111111111" },
            });
        },
    });
    const { response, record } = await recorder("https://graph.microsoft.com/v1.0/me/messages?$search=SYNTHETIC_QUERY", {
        headers: { authorization: "Bearer SYNTHETIC_SECRET" },
    });
    assert.equal(sent, 1);
    assert.equal(record, captured);
    assert.equal(record.synthetic, true);
    assert.equal(record.observedGraphHttp, false);
    assert.equal(record.paginationPresent, null);
    assert.doesNotMatch(JSON.stringify(captured), /SYNTHETIC_SECRET|SYNTHETIC_QUERY|SYNTHETIC_ENTITY_BODY/);
    assert.equal((await response.json()).value[0], "SYNTHETIC_ENTITY_BODY");
});

test("Graph recorder refuses non-Graph requests before dispatch and exposes persistence errors without retry", async () => {
    let sent = 0;
    const recorder = createGraphRecorder({
        enabled: true,
        persist: async () => { throw new Error("synthetic disk failure"); },
        testTransport: async () => { sent++; return new Response("synthetic body"); },
    });
    await assert.rejects(recorder("https://example.invalid/"), /versioned Microsoft Graph/);
    assert.equal(sent, 0);
    await assert.rejects(recorder("https://graph.microsoft.com/v1.0/$metadata"), (error) => {
        assert.ok(error instanceof GraphRecordingError);
        assert.ok(error.response instanceof Response);
        assert.match(error.message, /persistence failed/);
        return true;
    });
    assert.equal(sent, 1);
});

test("batch inspection retains status and pagination presence without entity body or link values", () => {
    const result = parseGraphJsonMetadata({
        "@odata.nextLink": "https://example.invalid/SYNTHETIC_LINK",
        responses: [{ status: 429, headers: { "retry-after": "3" }, body: { value: "SYNTHETIC_BODY" } }],
    });
    assert.equal(result.paginationPresent, true);
    assert.equal(result.batchSubresponses[0].status, 429);
    assert.equal(result.batchSubresponses[0].retryAfter.seconds, 3);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_BODY|SYNTHETIC_LINK/);
});
