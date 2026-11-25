import test from "node:test";
import assert from "node:assert/strict";
import {
    CLUSTER_ENGINE_VERSION, MAX_PROTOCOL_ARRAY, PyFloat, cluster, clusterId, diagnosticAnalysis, embeddedFailure,
    frameDiagnostic, loadRows, normalise, pyDumps, pyLoads, pyRound, strictLoads,
} from "../lib/mcp-diagnostics/cluster.mjs";

const J = JSON.stringify;
const text = (items) => J({ content: [{ type: "text", text: J(items) }] });

test("Python-compatible JSON keeps int/float identity and refuses unsafe documents", () => {
    assert.equal(pyDumps(pyLoads('{"b":[1.0,1e16,0.00001,-0.0,12345678901234567890],"a":"é"}'), { sortKeys: true }),
        '{"a": "\\u00e9", "b": [1.0, 1e+16, 1e-05, -0.0, 12345678901234567890]}');
    assert.equal(pyDumps({ x: [] , y: {} }, { indent: 2 }), '{\n  "x": [],\n  "y": {}\n}');
    assert.throws(() => strictLoads('{"a":1,"a":2}'), /duplicate key 'a'/);
    assert.throws(() => strictLoads('{"a":NaN}'), /non-finite JSON number NaN/);
    assert.equal(pyRound(0.25, 1).value, 0.2);
    assert.equal(pyRound(200 / 3, 1).value, 66.7);
});

test("flat WorkIQ retrieval errors and isError envelopes are explicit stop signals", () => {
    const flat = diagnosticAnalysis(J({ markdown: "", resultCount: 0, retrievalHits: [], stoppedReason: "error" }));
    assert.ok(flat.predicates.includes("stoppedReason=error"));
    assert.equal(flat.inconclusive, false);
    assert.ok(diagnosticAnalysis(J({ isError: true, structuredContent: { document: "private body" } }))
        .predicates.includes("isError"));
});

test("WorkIQ operation data is never scanned as a nested protocol error", () => {
    const body = { results: [
        { statusCode: 200, data: { title: "document", error: "example", statusCode: 500 } },
        { statusCode: 400, error: { code: "badRequest" } },
    ] };
    const result = diagnosticAnalysis(J(body), "error");
    assert.deepEqual(result.operations.map((op) => op.status_code), [200, 400]);
    assert.ok(result.predicates.includes("statusCode=400"));
    assert.ok(!result.predicates.includes("statusCode=500"));
    const successful = diagnosticAnalysis(J({ responses: [{ status: 200, body: { statusCode: 500 } }] }));
    assert.deepEqual(successful.predicates, []);
    assert.equal(successful.operations.length, 1);
});

test("operation diagnostics remain part of canonical grouping", () => {
    const rows = ["/me/messages", "/me/chats"].map((path) => ({
        tool: "workiq-fetch",
        err: frameDiagnostic({
            error: "",
            operations: [{ outcome: "fail", status_code: 400, diagnostic: J({ path, code: "accessDenied" }) }],
        }),
    }));
    assert.equal(cluster(rows, 20).length, 2);
});

test("redactor aliases of every kind collapse into one cluster", () => {
    const kinds = ["user", "id", "sess", "session", "call", "frame", "req", "request", "path", "path-id", "path-name",
        "opaque", "host", "tenant-host", "arg-id", "org", "collector"];
    const rows = [1, 2].map((index) => ({
        tool: "workiq-fetch",
        err: J({ statusCode: 403, message: kinds.map((kind) => `<${kind}-${index}:${String(index).repeat(12)}>`).join(" ") }),
    }));
    const groups = cluster(rows, 20);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
});

test("the full signature controls grouping and the stable cluster ID", () => {
    const prefix = "same ".repeat(70);
    const first = { tool: "fetch", err: `${prefix}{"code":"CODE_ALPHA","statusCode":500}` };
    const second = { tool: "fetch", err: `${prefix}{"code":"CODE_BETA","statusCode":500}` };
    const clusters = cluster([first, second], 20);
    assert.equal(clusters.length, 2);
    assert.ok(clusters.every((item) => item.signature_display_truncated && /^c-[0-9a-f]{24}$/.test(item.id)));
    const reordered = new Map(cluster([second, first, first], 20).map((item) => [item.signature, item.id]));
    for (const item of clusters) {
        assert.equal(reordered.get(item.signature), item.id);
        assert.equal(item.id, clusterId(item.tool, item.signature));
    }
});

test("structured normalisation is canonical and preserves diagnostic fields", () => {
    const left = normalise(J({
        requestId: "550e8400-e29b-41d4-a716-446655440000", statusCode: 429,
        path: "/v1/widgets/202609051234567890", code: "GraphError20260905Alpha",
    }));
    const right = normalise(J({
        code: "GraphError20260905Alpha", path: "/v1/widgets/202609051234567890", statusCode: 429,
        requestId: "123e4567-e89b-12d3-a456-426614174000",
    }));
    assert.equal(left, right);
    for (const fragment of ["GraphError20260905Alpha", "/v1/widgets/202609051234567890", '"statusCode":429', "<request_id>"]) {
        assert.ok(left.includes(fragment), fragment);
    }
});

test("members, days and samples conserve rows", () => {
    const err = J({ statusCode: 503, message: "x".repeat(500) });
    const [item] = cluster([
        { frame_id: "f-1", tool: "fetch", session: "s-1", ts: "2026-09-01T01:00:00Z", args: "a".repeat(300), err },
        { frame_id: "f-2", tool: "fetch", session: "s-2", ts: "2026-09-01T02:00:00Z", args: "", err },
        { frame_id: "f-3", tool: "fetch", session: "s-2", ts: "", args: "", err },
    ], 20);
    assert.deepEqual(item.frame_ids, ["f-1", "f-2", "f-3"]);
    assert.deepEqual(item.member_ids, item.frame_ids);
    assert.deepEqual(item.day_counts, { "2026-09-01": 2 });
    assert.equal(item.undated_count, 1);
    assert.equal(item.sessions, 2);
    assert.ok(item.sample_error_truncated && item.sample_args_truncated);
});

test("protocol text wrappers and status batches are scanned by one bounded walker", () => {
    const wrapped = J({ content: [{ type: "text", text: J([{ isError: true, status_code: "502" },
        { status: 500, stoppedReason: "error" }]) }], isError: false });
    assert.deepEqual(embeddedFailure(wrapped),
        ["isError", "operationFailure", "statusCode=500", "statusCode=502", "stoppedReason=error"]);
    const batch = diagnosticAnalysis(text([{ status: 200 }, { status: 500, code: "serverError" }]));
    assert.equal(batch.inconclusive, false);
    assert.deepEqual(batch.operations.map((op) => op.outcome), ["ok", "fail"]);
    assert.equal(batch.operations[1].error_code, "serverError");
    const documents = diagnosticAnalysis(text([{ title: "example incident", statusCode: 500, error: "quoted document" }]));
    assert.deepEqual([documents.predicates, documents.operations, documents.inconclusive], [[], [], true]);
});

test("prefixed, trailing and truncated JSON report honest completeness", () => {
    const payload = J([{ status: 200 }, { status: 503, code: "down" }]);
    const prefixed = diagnosticAnalysis(`host result: ${payload}`);
    assert.deepEqual([prefixed.scan_mode, prefixed.inconclusive, prefixed.operations.length], ["prefixed-json", false, 2]);
    const trailing = diagnosticAnalysis(`host result: ${payload} trailing host text`);
    assert.equal(trailing.inconclusive, true);
    assert.ok(trailing.predicates.includes("statusCode=503"));
    const truncated = diagnosticAnalysis('host result: [{"status":200},{"status":503');
    assert.deepEqual([truncated.scan_mode, truncated.inconclusive, truncated.predicates, truncated.metadata.status_codes],
        ["regex-fallback", true, ["statusCode=503"], ["503"]]);
});

test("array and identifier bounds are documented and explicitly inconclusive", () => {
    const within = diagnosticAnalysis(J(Array.from({ length: 211 }, () => ({ status: 200 }))));
    assert.deepEqual([within.operations.length, within.inconclusive], [211, false]);
    const over = diagnosticAnalysis(J(Array.from({ length: MAX_PROTOCOL_ARRAY + 1 },
        (_, index) => ({ status: 500, request_ids: [`request-${index}`] }))));
    assert.deepEqual([over.operations.length, over.inconclusive], [MAX_PROTOCOL_ARRAY, true]);
    const ids = diagnosticAnalysis(J({ status: 500,
        request_ids: Array.from({ length: MAX_PROTOCOL_ARRAY + 1 }, (_, index) => `request-${index}`) }));
    assert.deepEqual([ids.metadata.request_ids.length, ids.inconclusive], [MAX_PROTOCOL_ARRAY, true]);
    const content = diagnosticAnalysis(J({ content: Array.from({ length: MAX_PROTOCOL_ARRAY + 1 },
        () => ({ type: "text", text: J({ isError: false }) })) }));
    assert.deepEqual([content.predicates, content.body_available, content.inconclusive], [[], true, true]);
});

test("nested wrappers descend; WorkIQ MIME containers descend without opening user data", () => {
    const nested = diagnosticAnalysis(J({ result: { responses: [{ status: 200 }, { httpStatus: 502 }] } }));
    assert.equal(nested.operations.length, 2);
    assert.ok(nested.predicates.includes("statusCode=502"));
    assert.deepEqual(embeddedFailure(J({ result: { isError: true } })), ["isError"]);
    assert.deepEqual(embeddedFailure(J({
        "application/vnd.ms-workiq.retrieval": { markdown: "", resultCount: 0, stoppedReason: "error" },
        data: { stoppedReason: "error", isError: true },
    })), ["stoppedReason=error"]);
    const fallback = diagnosticAnalysis('transport stopped with "status": 500');
    assert.deepEqual([fallback.predicates, fallback.scan_mode, fallback.inconclusive], [["statusCode=500"], "regex-fallback", true]);
});

test("user data and empty error values are never treated as transport errors", () => {
    assert.deepEqual(embeddedFailure(J({ isError: false, data: { error: "example from a document", statusCode: 500 },
        value: [{ error: { message: "also user content" } }] })), []);
    for (const value of [null, false, "", " ", {}, []]) assert.deepEqual(embeddedFailure(J({ error: value })), []);
    assert.deepEqual(embeddedFailure('prefix "isError": true, "status_code": "504", "stoppedReason": "error", "error": null'),
        ["isError", "statusCode=504", "stoppedReason=error"]);
    assert.deepEqual(embeddedFailure('"error": false'), []);
    assert.deepEqual(embeddedFailure('"error": ""'), []);
});

test("structured status, code, path and request-ID variants are retained per cluster", () => {
    const [item] = cluster([{ frame_id: "f", tool: "ask", err: J({
        http_status_code: "429", errorCode: "TooManyRequests2026", request_id: "req-1", clientRequestId: "client-2",
        "x-ms-request-id": "xms-3", correlation_id: "corr-4", requestPath: "/messages/12345678901234567890",
    }) }], 20);
    assert.deepEqual(item.status_codes, ["429"]);
    assert.deepEqual(item.error_codes, ["TooManyRequests2026"]);
    assert.deepEqual(item.request_ids, ["client-2", "corr-4", "req-1", "xms-3"]);
    assert.deepEqual([item.client_request_ids, item.x_ms_request_ids, item.correlation_ids],
        [["client-2"], ["xms-3"], ["corr-4"]]);
    assert.deepEqual(item.paths, ["/messages/12345678901234567890"]);
});

test("typed-only diagnostics group separately and frame diagnostics ignore correlation", () => {
    const groups = cluster([
        { frame_id: "f-403", tool: "fetch", err: "", status_code: 403, error_code: "accessDenied" },
        { frame_id: "f-500", tool: "fetch", err: "", status_code: 500, error_code: "generalException" },
    ], 20);
    assert.deepEqual(new Set(groups.map((item) => `${item.status_codes[0]}:${item.error_codes[0]}`)),
        new Set(["403:accessDenied", "500:generalException"]));
    const first = {
        error: J({ statusCode: 500, request_ids: ["<request-1:aaaa>"] }), status_code: 500, error_code: "serverError",
        request_ids: ["<request-1:aaaa>"],
        operations: [{ outcome: "fail", status_code: 500, error_code: "serverError", request_ids: ["<request-1:aaaa>"] }],
    };
    const second = structuredClone(first);
    second.error = J({ request_ids: ["<request-9:bbbb>", "<request-8:cccc>"], statusCode: 500 });
    second.request_ids = ["<request-8:cccc>", "<request-9:bbbb>"];
    second.operations[0].request_ids = second.request_ids;
    assert.equal(normalise(frameDiagnostic(first)), normalise(frameDiagnostic(second)));
    assert.equal(CLUSTER_ENGINE_VERSION, 2);
});

test("status values must be strict integral HTTP codes", () => {
    for (const value of ['true', "500.9", "NaN", '"NaN"', "99", "600"]) {
        assert.ok(!diagnosticAnalysis(`{"status": ${value}}`).predicates.includes("statusCode=500"), value);
    }
    assert.ok(diagnosticAnalysis('{"httpStatus": 500.0}').predicates.includes("statusCode=500"));
    assert.ok(pyLoads("500.0") instanceof PyFloat);
});

test("malformed JSONL is counted, never guessed", () => {
    const valid = J({ tool: "a", err: { statusCode: 500 } });
    const { rows, bad } = loadRows([valid, "{not json}", valid].join("\n"));
    assert.equal(rows.length, 2);
    assert.match(bad[0], /^line 2: not valid JSON/);
    const corrupt = Buffer.concat([
        Buffer.from('{"tool":"a","err":"x"}\n{"tool":"bad","err":"'), Buffer.from([0xff]),
        Buffer.from('"}\n{"tool":"nan","err":NaN}\n{"tool":"dup","tool":"again","err":"x"}\n42\n'),
    ]);
    const mixed = loadRows(corrupt);
    assert.deepEqual([mixed.rows.length, mixed.bad.length], [1, 4]);
    assert.deepEqual(loadRows(""), { rows: [], bad: [], seenKeys: new Set() });
});
