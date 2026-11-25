import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    InputError, RedactionGateError, artifactLimits, buildBundle, deduplicateFrames, filterServer, ingest, toUtc,
    verdictsTemplate, writeBundle,
} from "../lib/mcp-diagnostics/collect.mjs";
import { inspectBundle } from "../lib/mcp-diagnostics/inspect.mjs";
import { listEntries } from "../lib/mcp-diagnostics/zip.mjs";

const J = JSON.stringify;
const NOW = new Date(Date.UTC(2026, 8, 10, 12));
const work = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".mcp-diagnostics-bundle-"));
after(() => rmSync(work, { recursive: true, force: true }));

const utc = (days = 0) => new Date(NOW.getTime() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const build = (rows, options = {}) => buildBundle(rows, { server: "workiq", collector: "tester", now: NOW, ...options });
const artifact = (result, name) => JSON.parse(result.files[name]);
const jsonl = (result, name) => (result.files[name] ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const frames = (rows, options) => {
    const { frames: output, bad } = ingest(rows, options);
    assert.deepEqual(bad, []);
    return output;
};
const basicRows = () => [
    { ts: utc(-1), session_id: "s1", call_id: "ok1", server: "workiq", tool: "workiq-fetch", outcome: "ok", result: {} },
    { ts: utc(-1), session_id: "s1", call_id: "bad1", server: "workiq", tool: "workiq-fetch", outcome: "fail",
        error: { statusCode: 503, code: "upstreamUnavailable", requestId: "trace-12345678" }, result: {} },
];
const firstClusterId = () => build(basicRows()).summary.clusters[0].id;

test("canonical fields are typed; host and effective outcomes stay separate", () => {
    const [first, second] = frames([
        { ts: utc(), session_id: "s1", call_id: "c1", server: "workiq", tool: "workiq-fetch", outcome: "unknown",
            statusCode: 418, request_ids: ["supplied-request-123"], embedded_failure: ["supplied-predicate"],
            result: { isError: true, statusCode: 503 } },
        { ts: utc(), session_id: "s1", call_id: "c2", server: "workiq", tool: "workiq-fetch", success: true, error: false,
            result: {} },
    ]);
    assert.deepEqual([first.outcome, first.effective_outcome, first.status_code, first.request_ids[0], first.server],
        ["unknown", "fail", 418, "supplied-request-123", "workiq"]);
    assert.ok(first.embedded_failure.includes("supplied-predicate") && first.embedded_failure.includes("isError"));
    assert.deepEqual([second.outcome, second.effective_outcome, second._diagnostic_raw], ["ok", "ok", ""]);
    const [supplied] = frames([{ frame_id: `f-${"a".repeat(24)}`, ts: utc(), server: "workiq", tool: "workiq-fetch",
        outcome: "fail", effective_outcome: "fail", status_code: 500, error: { statusCode: 500, code: "generalException" } }]);
    assert.equal(supplied.frame_id, `f-${"a".repeat(24)}`);
});

test("per-operation statuses are retained separately from the call", () => {
    const [frame] = frames([{ ts: utc(), session_id: "s1", call_id: "batch1", server: "workiq",
        tool: "workiq-call_function", success: false,
        result: [{ status: 200, code: "ok" }, { statusCode: 404, code: "itemNotFound", requestId: "req-12345678" }] }]);
    assert.deepEqual([frame.outcome, frame.effective_outcome, frame.status_code, frame.error_code],
        ["fail", "fail", 404, "itemNotFound"]);
    assert.deepEqual(frame.operations.map((operation) => operation.outcome), ["ok", "fail"]);
    const [document, batch] = frames([
        { tool: "workiq-fetch", server: "workiq", outcome: "ok",
            result: { content: [{ type: "text", text: J([{ title: "quoted", statusCode: 500, error: "document text" }]) }] } },
        { tool: "workiq-fetch", server: "workiq", outcome: "ok", result: [{ status: 200 }, { status: 500, code: "serverError" }] },
    ]);
    assert.deepEqual([document.effective_outcome, document.operations], ["ok", []]);
    assert.deepEqual([batch.effective_outcome, batch.operations.length], ["fail", 2]);
    assert.ok(batch.embedded_failure.includes("statusCode=500"));
});

test("prefixed, trailing and truncated payloads remain inconclusive", () => {
    const batch = J([{ status: 200 }, { status: 500, code: "serverError" }]);
    const [trailing, truncated] = frames([
        { tool: "workiq-fetch", server: "workiq", outcome: "ok", result: `host result: ${batch} trailing host text` },
        { tool: "workiq-fetch", server: "workiq", outcome: "fail", result: 'host result: [{"status":200},{"sta' },
    ]);
    assert.deepEqual([trailing.operations.length, trailing._payload_scan_inconclusive, trailing.effective_outcome],
        [2, true, "fail"]);
    assert.deepEqual([truncated._payload_scan_inconclusive, truncated.status_code], [true, null]);
});

test("naive timestamps are refused unless an explicit offset is supplied", () => {
    assert.throws(() => toUtc("2026-09-05 09:30:00"), InputError);
    assert.throws(() => toUtc("not-a-date"), InputError);
    assert.deepEqual(toUtc("2026-09-05 09:30:00", "-07:00"), ["2026-09-05T16:30:00.000Z", "-07:00"]);
    for (const raw of ["2026-09-05 09:30:00+00", "2026-09-05 09:30:00+0000", "2026-09-05T09:30:00.123-07",
        "2026-09-05T09:30:00.123-0700"]) {
        const [converted, offset] = toUtc(raw);
        assert.match(converted, /Z$/, raw);
        assert.match(offset, /^[+-]\d{2}:\d{2}$/);
    }
    assert.deepEqual(toUtc("05/Sep/2026:09:30:00 +0200"), ["2026-09-05T07:30:00.000Z", "+02:00"]);
    assert.deepEqual(toUtc("2026-09-05T09:30:00.123456Z"), ["2026-09-05T09:30:00.123Z", "+00:00"]);
    assert.deepEqual(toUtc(null), [null, null]);
});

test("server filtering is exact and never relabels", () => {
    const all = frames([
        { ts: utc(), server: "workiq", tool: "workiq-fetch", outcome: "fail", error: { statusCode: 500 } },
        { ts: utc(), server: "kusto", tool: "kusto-query", outcome: "fail", error: { statusCode: 500 } },
        { ts: utc(), tool: "task-ask", outcome: "fail", error: { statusCode: 500 } },
    ]);
    assert.deepEqual(filterServer(all, "workiq").map((frame) => frame.tool), ["workiq-fetch"]);
    assert.equal(all[1].server, "kusto");
    assert.deepEqual(filterServer(all, "ask"), []);
});

test("duplicate call identities deduplicate exactly and refuse conflicts", () => {
    const all = frames([...basicRows(), basicRows()[0]]);
    const { frames: deduped, duplicateCount } = deduplicateFrames(all);
    assert.deepEqual([deduped.length, duplicateCount], [2, 1]);
    assert.throws(() => deduplicateFrames([all[0], { ...all[0], tool: "workiq-ask" }]), InputError);
    const row = { tool: "workiq-fetch", server: "workiq", outcome: "fail", status_code: 500 };
    const anonymous = frames([row, row]);
    assert.equal(new Set(anonymous.map((frame) => frame.frame_id)).size, 2);
    assert.equal(deduplicateFrames(anonymous).duplicateCount, 0);
    const supplied = { ...anonymous[0], _frame_id_source: "supplied", frame_id: `f-${"b".repeat(24)}` };
    assert.throws(() => deduplicateFrames([supplied, { ...supplied }]), InputError);
});

test("a sample capture withholds rates and checksums cover final bytes", () => {
    const result = build(basicRows(), { org: "review" });
    const { summary, manifest } = result;
    assert.deepEqual([summary.schema_version, summary.volume.rate_available, summary.volume.fail_pct_of_all,
        summary.capture_scope], [2, false, null, "sample"]);
    assert.deepEqual(summary.clustering, { engine_version: 2, opaque: 20 });
    assert.deepEqual(manifest.clustering, summary.clustering);
    assert.ok(result.report.includes(summary.top_issues[0].cluster_id));
    assert.deepEqual(new Set(jsonl(result, "failures.jsonl").map((frame) => frame.frame_id)),
        new Set(summary.clusters.flatMap((item) => item.frame_ids)));
    assert.deepEqual(artifact(result, "clusters.json"), summary.clusters);
    assert.deepEqual(artifact(result, "coverage.json"), summary.coverage);
    assert.deepEqual(artifact(result, "environment.json"), summary.environment);
    assert.deepEqual(Object.keys(manifest.checksums).sort(),
        Object.keys(result.files).filter((name) => name !== "manifest.json").sort());
    assert.ok(manifest.omitted.some((item) => item.file === "controls.jsonl"));
    for (const [name, expected] of Object.entries(manifest.checksums)) {
        assert.equal(`sha256:${createHash("sha256").update(result.files[name]).digest("hex")}`, expected, name);
    }
    assert.equal(result.verification.passed, true);
});

test("a complete rate needs matching host totals, payload coverage and conclusive scans", () => {
    const complete = build(basicRows(), { captureScope: "complete", expectedCalls: 2, expectedFailures: 1 }).summary;
    assert.deepEqual([complete.reconciliation.status, complete.volume.rate_available, complete.volume.fail_pct_of_all],
        [true, true, 50]);
    assert.ok(build(basicRows(), { captureScope: "complete", expectedCalls: 2, expectedFailures: 1 })
        .files["summary.json"].includes('"fail_pct_of_all": 50.0'));
    const unsupplied = build(basicRows(), { captureScope: "complete" }).summary;
    assert.deepEqual([unsupplied.reconciliation.status, unsupplied.volume.rate_available], [null, false]);
    assert.throws(() => build(basicRows(), { expectedCalls: 2 }), /must be supplied together/);
    const bounded = build([{ ts: utc(), session_id: "s1", call_id: "c1", server: "workiq", tool: "workiq-fetch",
        outcome: "ok", result: Array.from({ length: 1001 }, () => ({ status: 200 })) }],
    { captureScope: "complete", expectedCalls: 1, expectedFailures: 0 }).summary;
    assert.equal(bounded.payload_scan.inconclusive_calls, 1);
    assert.equal(bounded.volume.rate_available, false);
    assert.match(bounded.rate_reason, /inconclusive/);
    const gaps = build(basicRows(), { captureScope: "complete", expectedCalls: 2, expectedFailures: 1,
        sourceTruncated: true, unmatchedStarts: 2 }).summary;
    assert.deepEqual([gaps.reconciliation.status, gaps.volume.rate_available, gaps.source_integrity.truncated,
        gaps.source_integrity.unmatched_starts], [false, false, true, 2]);
});

test("reconciliation compares host failures, not effective failures", () => {
    const { summary } = build([
        { ts: utc(), session_id: "s1", call_id: "hidden", server: "workiq", tool: "workiq-fetch", outcome: "ok",
            result: { isError: true, statusCode: 502 } },
        { ts: utc(), session_id: "s1", call_id: "host-fail", server: "workiq", tool: "workiq-fetch", outcome: "fail",
            error: { statusCode: 500 }, result: {} },
    ], { captureScope: "complete", expectedCalls: 2, expectedFailures: 1 });
    assert.deepEqual([summary.raw_volume.host_outcomes.fail, summary.raw_volume.effective_outcomes.fail,
        summary.reconciliation.status, summary.volume.fail_pct_of_all], [1, 2, true, 100]);
});

test("malformed rows are refused by default and excluded visibly when partial is allowed", () => {
    const text = `${J(basicRows()[0])}\n{not-json}\n`;
    assert.throws(() => build(text), (error) => error instanceof InputError && /malformed row/.test(error.message));
    assert.equal(build(text, { allowPartial: true }).summary.limitations.excluded["malformed or invalid rows"], 1);
    assert.throws(() => build(`{"ts":"${utc()}","tool":"workiq-fetch","tool":"kusto-query"}\n`),
        (error) => /duplicate JSON key/.test(error.details.join("\n")));
});

test("probe exclusions use stable frame IDs and keep raw evidence", () => {
    const first = build(basicRows()).summary;
    const clusterId = first.clusters[0].id;
    const probeId = first.clusters[0].frame_ids[0];
    const result = build(basicRows(), {
        captureScope: "complete", expectedCalls: 2, expectedFailures: 1,
        verdicts: { schema_version: 2, top_issues: [clusterId], probe_frame_ids: [probeId],
            clusters: { [clusterId]: { verdict: "test-probe", rw_class: "read" } } },
    });
    const { summary } = result;
    const [failure] = jsonl(result, "failures.jsonl");
    assert.deepEqual([summary.raw_volume.effective_outcomes.fail, summary.volume.fail,
        summary.volume.excluded_test_probe_calls], [1, 0, 1]);
    assert.equal(failure.excluded_from_production, true);
    assert.deepEqual([summary.clusters[0].id, summary.clusters[0].excluded_frame_ids, summary.clusters[0].adjusted_count],
        [clusterId, [failure.frame_id], 0]);
});

test("cluster IDs survive rank changes and day counts conserve", () => {
    const rows = (a, b) => [
        ...Array.from({ length: a }, (_, index) => ({ ts: utc(-index), session_id: "sa", call_id: `a${index}`,
            server: "workiq", tool: "workiq-fetch", outcome: "fail", error: { statusCode: 403, code: "accessDenied" } })),
        ...Array.from({ length: b }, (_, index) => ({ ts: utc(-index), session_id: "sb", call_id: `b${index}`,
            server: "workiq", tool: "workiq-fetch", outcome: "fail", error: { statusCode: 500, code: "generalException" } })),
    ];
    const bySignature = (result) => new Map(result.summary.clusters.map((item) => [item.signature, item]));
    const first = bySignature(build(rows(1, 3)));
    const second = bySignature(build(rows(5, 3)));
    for (const [signature, item] of first) assert.equal(second.get(signature).id, item.id);
    for (const item of second.values()) {
        const material = J([item.tool, item.signature]);
        assert.equal(item.id, `c-${createHash("sha256").update(material).digest("hex").slice(0, 24)}`);
        assert.deepEqual(Object.keys(item.day_counts).sort(), item.days);
        assert.equal(item.count, Object.values(item.day_counts).reduce((a, b) => a + b, 0) + item.unknown_date_count);
    }
});

test("verdicts are validated against stable references", () => {
    const clusterId = firstClusterId();
    for (const verdicts of [
        { schema_version: 2, clusters: { "c-deadbeef": { verdict: "product-bug" } } },
        { schema_version: 2, top_issues: [{ cluster_id: "c-deadbeef", hits: 99 }] },
        { schema_version: 2, clusters: { [clusterId]: { rw_class: "maybe" } } },
        { schema_version: 2, clusters: { [clusterId]: { evidence_track: "A" } } },
        { schema_version: 2, clusters: { [clusterId]: { evidence_track: "B", reproduction_disposition: "not-attempted" } } },
        { schema_version: 1 },
    ]) {
        assert.throws(() => build(basicRows(), { verdicts }), InputError, J(verdicts));
    }
    assert.deepEqual(verdictsTemplate(), { schema_version: 2, headline: "", top_issues: [], probe_frame_ids: [], asks: [],
        our_actions: [], clusters: {} });
    const unclassified = build(basicRows(), { verdicts: J(verdictsTemplate()) }).summary.clusters[0];
    assert.deepEqual([unclassified.verdict, unclassified.rw_class, unclassified.evidence_verified],
        ["unclassified", "unknown-treat-as-write", false]);
});

test("unreviewed narrative is discarded; reviewed narrative is plain data", () => {
    const clusterId = firstClusterId();
    const verdicts = { schema_version: 2, headline: "Project ORCHID customer escalation",
        clusters: { [clusterId]: { verdict: "product-bug", rw_class: "unknown-treat-as-write",
            mechanism: "Invented mechanism prose" } } };
    const discarded = build(basicRows(), { verdicts }).summary;
    assert.equal(discarded.headline, "");
    assert.equal(discarded.clusters[0].verdict, "product-bug");
    assert.ok(!("mechanism" in discarded.clusters[0]));
    assert.ok(discarded.limitations.narrative.discarded_fields.includes("headline"));
    const reviewed = build(basicRows(), { verdicts, reviewedNarrative: true }).summary;
    assert.ok(reviewed.headline.includes("ORCHID") && "mechanism" in reviewed.clusters[0]);
    const headline = "Reviewed\n## Failure clusters\n![fake](https://example.invalid) | 9999";
    const { report } = build(basicRows(), { reviewedNarrative: true,
        verdicts: { schema_version: 2, headline, clusters: { [clusterId]: { verdict: "product-bug" } } } });
    assert.equal(report.split("## Failure clusters").length - 1, 1);
    assert.ok(!report.includes("![fake](") && report.includes("\\#\\# Failure clusters"));
});

test("external profile aliases labels; probe and environment are projected", () => {
    const external = build(basicRows(), { profile: "external", org: "contoso-hr-tenant", collector: "tolga.kayadelen" });
    assert.match(external.bundleId, /^mcp-diag-external-/);
    const all = Object.values(external.files).join("\n");
    assert.ok(!all.includes("tolga.kayadelen") && !all.includes("contoso-hr-tenant"));
    const probe = build(basicRows(), { probe: { tool: "workiq-fetch", statusCode: 503,
        result: { subject: "Confidential compensation review", markdown: "Private document body", code: "upstreamUnavailable" } } });
    const projected = probe.files["probe-results.json"];
    assert.ok(projected.includes("503") && !projected.includes("Confidential") && !projected.includes("Private document"));
    const environment = build(basicRows(), { environment: {
        host: { name: "copilot", version: "1.2.3", os: "macos" },
        server: { name: "workiq", version: "2.0", transport: "stdio", auth_mode: "oauth" },
        local_offset: "-07:00", secretProjectORCHID: "private-value",
    } });
    const env = artifact(environment, "environment.json");
    assert.deepEqual([env.local_offset, env.server.transport, "secretProjectORCHID" in env], ["-07:00", "stdio", false]);
    assert.ok(!Object.values(environment.files).join("\n").includes("private-value"));
    const mixed = build([...basicRows(), { ts: utc(), session_id: "k", call_id: "k1", server: "secret-tenant-host",
        tool: "kusto-query", outcome: "fail", status_code: 500 }], { profile: "external" });
    assert.equal(mixed.summary.limitations.excluded["other servers"], 1);
    assert.ok(!Object.values(mixed.files).join("\n").includes("secret-tenant-host"));
});

test("the final gate scans the exact artifact set and refuses residue", () => {
    let scanned;
    const reject = (files, profile) => {
        scanned = { names: Object.keys(files), profile };
        return { ran: true, passed: false, findings: [{ file: "manifest.json", rule: "planted" }], finding_count: 1 };
    };
    assert.throws(() => build(basicRows(), { verify: reject }), RedactionGateError);
    assert.equal(scanned.profile, "internal");
    for (const name of ["manifest.json", "redaction-report.json", "README.md", "report.md"]) assert.ok(scanned.names.includes(name));
    assert.throws(() => artifactLimits({ "large.json": "x".repeat(11) }, { maxFileBytes: 10, maxBundleBytes: 15 }), InputError);
    assert.throws(() => artifactLimits({ "a.json": "x".repeat(8), "b.json": "y".repeat(8) },
        { maxFileBytes: 10, maxBundleBytes: 15 }), InputError);
});

test("the ZIP holds exactly one flat root, is private, unique and never overwritten", () => {
    const output = join(work, "out");
    const result = build(basicRows(), { org: "review" });
    const path = writeBundle(result, output);
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(output), [result.archiveName]);
    const names = listEntries(readFileSync(path)).map((entry) => entry.name).sort();
    assert.deepEqual(names, Object.keys(result.files).sort().map((name) => `${result.bundleId}/${name}`));
    assert.throws(() => writeBundle(result, output), /refusing to reuse/);
    const second = writeBundle(build(basicRows()), output);
    assert.notEqual(second, path);
    assert.equal(inspectBundle(path).summary.volume.calls, 2);
    assert.ok(!existsSync(join(output, result.bundleId)));
});

test("reports never infer 'nothing found' and label raw versus adjusted populations", () => {
    const hidden = build([{ ts: utc(), session_id: "s1", call_id: "c1", server: "workiq", tool: "workiq-fetch", outcome: "ok",
        result: { content: [{ type: "text", text: J([{ isError: true, status_code: "502" },
            { status: 500, stoppedReason: "error" }]) }], isError: false } }]);
    assert.ok(!hidden.report.toLowerCase().includes("nothing found") && hidden.report.includes("structured predicate"));
    const rows = ["probe", "user"].map((name) => ({ ts: utc(), session_id: "s", call_id: name, tool: "workiq-fetch",
        server: "workiq", outcome: "ok", result: { isError: true, statusCode: 503 } }));
    const probeId = frames(rows).find((frame) => frame.call_id === "probe").frame_id;
    const result = build(rows, { verdicts: { schema_version: 2, probe_frame_ids: [probeId], clusters: {} } });
    const population = result.summary.embedded_failure_population;
    assert.deepEqual([population.raw_affected_calls, population.adjusted_remaining_calls], [2, 1]);
    assert.ok(population.predicate_hits >= 2);
    assert.ok(result.report.includes("Raw evidence: 2 call(s)") && result.report.includes("adjusted remaining affected calls: 1"));
});

test("a missing timestamp is null and visible as a limitation", () => {
    const result = build([{ session_id: "s1", call_id: "c1", server: "workiq", tool: "workiq-fetch", outcome: "fail",
        error: { statusCode: 500, code: "failure" } }]);
    assert.equal(jsonl(result, "failures.jsonl")[0].ts, null);
    assert.ok(result.summary.limitations.not_visible.some((item) => item.includes("no timestamp")));
});

test("unstructured diagnostic fields and conflicting aliases are refused", () => {
    for (const extra of [{ error_code: "customer private explanation" }, { request_ids: ["request id with spaces"] },
        { tool: "workiq fetch with prose" }, { status_code: true }, { status_code: 500.9 }, { duration_ms: true },
        { duration_ms: "NaN" }]) {
        assert.throws(() => build([{ ts: utc(), tool: "workiq-fetch", server: "workiq", outcome: "fail", ...extra }]),
            InputError, J(extra));
    }
    for (const row of [
        { outcome: "ok", success: false },
        { success: true, error: false, tool_complete_error_message: { statusCode: 503 } },
        { success: true, result: {}, body: { isError: true } },
    ]) {
        const { frames: output, bad } = ingest([{ ts: utc(), tool: "workiq-fetch", server: "workiq", ...row }]);
        assert.deepEqual(output, []);
        assert.match(bad[0], /conflict/);
    }
    assert.equal(frames([{ ts: utc(), tool: "workiq-fetch", server: "workiq", success: false,
        error: { statusCode: 503 }, err: '{"statusCode":503}' }])[0].outcome, "fail");
});

test("operation paths are schema locators, not prose or URIs", () => {
    const operation = (path, outcome = "fail") => [{ ts: utc(), tool: "workiq-fetch", server: "workiq", outcome,
        operations: [{ path, outcome: "fail", status_code: 500, error_code: "serverError", request_ids: ["request-12345678"] }] }];
    for (const path of ["PrivateCustomerPlan", "https://tenant.example/private/item", "$.results[customer-id]"]) {
        const { frames: output, bad } = ingest(operation(path));
        assert.deepEqual(output, []);
        assert.match(bad[0], /operation path/);
    }
    for (const path of ["$.results[0]", "$.*[0]"]) {
        const [frame] = frames(operation(path, "ok"));
        assert.deepEqual([frame.operations[0].path, frame.operations[0].status_code, frame.effective_outcome],
            [path, 500, "fail"]);
    }
});

test("all request IDs, float durations and typed statuses survive normalization", () => {
    const requestIds = Array.from({ length: 25 }, (_, index) => `request-${String(index).padStart(2, "0")}-abcdef`);
    const text = J({ ts: utc(), tool: "workiq-fetch", server: "workiq", outcome: "fail", status_code: 500,
        duration_ms: 12.5, request_ids: requestIds });
    const [frame] = frames(text);
    assert.deepEqual([frame.request_ids, Number(frame.duration_ms)], [requestIds, 12.5]);
    assert.deepEqual(jsonl(build(text), "failures.jsonl")[0].request_ids, requestIds);
    assert.ok(build('{"ts":"2026-09-10T00:00:00Z","tool":"workiq-fetch","server":"workiq","outcome":"fail","duration_ms":12.0}')
        .files["failures.jsonl"].includes('"duration_ms": 12.0'));
    const [typed] = frames([{ ts: utc(), tool: "workiq-fetch", server: "workiq", outcome: "ok", status_code: 503 }]);
    assert.deepEqual([typed.outcome, typed.effective_outcome], ["ok", "fail"]);
    assert.ok(typed.embedded_failure.includes("statusCode=503"));
    const { summary } = build([
        { ts: utc(), session_id: "s", call_id: "a", tool: "workiq-fetch", server: "workiq", outcome: "fail",
            status_code: 403, error_code: "accessDenied" },
        { ts: utc(), session_id: "s", call_id: "b", tool: "workiq-fetch", server: "workiq", outcome: "fail",
            status_code: 500, error_code: "generalException" },
    ]);
    assert.deepEqual(new Set(summary.clusters.map((item) => `${item.status_codes[0]}:${item.error_codes[0]}`)),
        new Set(["403:accessDenied", "500:generalException"]));
});

test("partial probe selection keeps the shared production cluster", () => {
    const rows = [
        { ts: utc(-1), session_id: "probe", call_id: "p1", tool: "workiq-fetch", server: "workiq", outcome: "fail",
            error: { statusCode: 503, code: "sameFailure" } },
        { ts: utc(), session_id: "user", call_id: "u1", tool: "workiq-fetch", server: "workiq", outcome: "fail",
            error: { statusCode: 503, code: "sameFailure" } },
    ];
    const probeId = frames(rows).find((frame) => frame.call_id === "p1").frame_id;
    const clusterId = build(rows).summary.clusters[0].id;
    const { summary } = build(rows, { verdicts: { schema_version: 2, probe_frame_ids: [probeId],
        clusters: { [clusterId]: { verdict: "product-bug" } } } });
    assert.deepEqual([summary.clusters[0].count, summary.clusters[0].adjusted_count, summary.clusters[0].excluded_frame_ids,
        summary.volume.fail], [2, 1, [probeId], 1]);
    assert.throws(() => build(rows, { verdicts: { schema_version: 2, probe_frame_ids: [probeId],
        clusters: { [clusterId]: { verdict: "test-probe", rw_class: "read" } } } }), /test-probe verdict/);
});

test("track A publishes the referenced control and stays an unverified assertion", () => {
    const rows = [
        { ts: utc(), session_id: "s", call_id: "failure", tool: "workiq-fetch", server: "workiq", outcome: "fail",
            status_code: 503, request_ids: ["request-abcdefgh"] },
        { ts: utc(), session_id: "s", call_id: "control", tool: "workiq-fetch", server: "workiq", outcome: "ok",
            result: {}, request_ids: ["request-control1"] },
    ];
    const byCall = Object.fromEntries(frames(rows).map((frame) => [frame.call_id, frame.frame_id]));
    const clusterId = build(rows).summary.clusters[0].id;
    const result = build(rows, { verdicts: { schema_version: 2, clusters: { [clusterId]: {
        verdict: "product-bug", rw_class: "read", evidence_track: "A",
        evidence: { failing_frame_ids: [byCall.failure], control_frame_ids: [byCall.control],
            correlation_ids: ["request-abcdefgh"] } } } } });
    assert.deepEqual(jsonl(result, "controls.jsonl").map((frame) => frame.frame_id), [byCall.control]);
    const [item] = artifact(result, "clusters.json");
    assert.deepEqual([item.evidence_track, item.evidence_track_asserted, item.evidence_verified], ["A", "A", false]);
    assert.ok(result.report.includes("unverified"));
    assert.ok("controls.jsonl" in result.manifest.checksums);
    assert.ok(!result.manifest.omitted.some((entry) => entry.file === "controls.jsonl"));
    const path = writeBundle(result, join(work, "track-a"));
    assert.equal(inspectBundle(path).summary.controls.count, 1);
});

test("both profiles cross the archive boundary with operation diagnostics intact", () => {
    const rows = [
        { ts: "2026-09-05 12:00:00+00", session_id: "s1", call_id: "ok", tool: "workiq-fetch", outcome: "ok", result: {} },
        { ts: "2026-09-05 12:00:01.001+0000", session_id: "s1", call_id: "batch", tool: "workiq-fetch", outcome: "fail",
            args: { query: "Do not ship PrivateRoadmap" },
            error: `MCP server 'workiq': ${J({ results: [{ statusCode: 200, data: { body: "HARVESTED_SECRET" } },
                { statusCode: 500, error: { code: "generalException" } }] })}` },
        { ts: "2026-09-05T12:00:02Z", session_id: "s2", call_id: "hidden", tool: "workiq-retrieve", outcome: "ok",
            result: { "application/vnd.ms-workiq.retrieval": { stoppedReason: "error", markdown: "HARVESTED_SECRET",
                resultCount: 0 } } },
    ];
    const counts = [];
    for (const profile of ["internal", "external"]) {
        const result = build(rows, { profile, captureScope: "complete", expectedCalls: 3, expectedFailures: 1, opaque: 28 });
        const { summary } = inspectBundle(writeBundle(result, join(work, `boundary-${profile}`)));
        assert.deepEqual([summary.raw_volume.calls, summary.raw_volume.host_outcomes.fail, summary.volume.fail,
            summary.raw_volume.operation_diagnostics, summary.clustering.opaque, summary.permission_to_replay_or_write],
        [3, 1, 2, 2, 28, false]);
        const all = Object.values(result.files).join("\n");
        assert.ok(!all.includes("HARVESTED_SECRET") && !all.includes("PrivateRoadmap"));
        counts.push(summary.clusters.length);
    }
    assert.equal(counts[0], counts[1]);
});
