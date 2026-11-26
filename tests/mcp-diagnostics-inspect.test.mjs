import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cluster, frameDiagnostic } from "../lib/mcp-diagnostics/cluster.mjs";
import { BundleRefusedError, OPTIONAL, inspectBundle } from "../lib/mcp-diagnostics/inspect.mjs";
import { createZip } from "../lib/mcp-diagnostics/zip.mjs";

const J = JSON.stringify;
const ROOT = "mcp-diag-test";
const work = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".mcp-diagnostics-inspect-"));
after(() => rmSync(work, { recursive: true, force: true }));

function makeFiles() {
    const frame = {
        frame_id: `f-${"1".repeat(24)}`, ts: "2026-09-05T10:00:00Z", tool: "workiq-fetch", outcome: "fail",
        effective_outcome: "fail", session_id: "s1", call_id: "call1", server: "workiq",
        error: '{"statusCode":500,"code":"generalException"}', args: "{}", status_code: 500,
        error_code: "generalException", request_ids: [], embedded_failure: [], operations: [], duration_ms: null,
        adapter: "jsonl", excluded_from_production: false, exclusion_reason: null,
    };
    const [item] = cluster([{ frame_id: frame.frame_id, tool: frame.tool, ts: frame.ts, session: frame.session_id,
        args: frame.args, err: frameDiagnostic(frame) }], 20);
    Object.assign(item, { verdict: "unclassified", excluded_frame_ids: [], adjusted_count: 1, evidence_track: null,
        evidence: {}, evidence_verified: false, rw_class: "unknown-treat-as-write" });
    const volume = { calls: 2, ok: 1, fail: 1, unknown: 0, excluded_test_probe_calls: 0, rate_available: false,
        fail_pct_of_known: null, fail_pct_of_all: null };
    const coverage = { tools: [{ tool: "workiq-fetch", ...volume }] };
    const summary = {
        schema_version: 2, bundle_id: ROOT, volume, clusters: [item], coverage, environment: {},
        raw_volume: { calls: 2, host_outcomes: { ok: 1, fail: 1, unknown: 0 },
            effective_outcomes: { ok: 1, fail: 1, unknown: 0 }, embedded_failure_calls: 0 },
        profile: "internal", capture_scope: "sample", window: {},
        source_integrity: { truncated: false, retention_incomplete: false, unmatched_starts: 0, identical_duplicates: 0,
            malformed_rows: 0 },
        reconciliation: { status: null, expected_calls: null, observed_calls: 2, expected_host_failures: null,
            observed_host_failures: 1 },
        clustering: { engine_version: 2, opaque: 20 }, limitations: { excluded: {} }, top_issues: [],
        payload_scan: { scanned_calls: 1, missing_nonfailed_payloads: 1, inconclusive_calls: 0 },
        embedded_failures: [], live_reproduction_performed: false, permission_to_replay_or_write: false,
    };
    return {
        "README.md": "Read report.md", "report.md": "# Diagnostic", "summary.json": J(summary),
        "environment.json": "{}", "coverage.json": J(coverage), "clusters.json": J([item]), "failures.jsonl": J(frame),
        "embedded.json": "[]",
        "redaction-report.json": J({ verification: { ran: true, passed: true, findings: [] } }),
    };
}

function archive(name, files, { manifest: changes = {}, extra = [] } = {}) {
    const summary = JSON.parse(files["summary.json"]);
    const manifest = {
        schema_version: 2, bundle_id: ROOT, profile: "internal",
        checksums: Object.fromEntries(Object.entries(files).map(([file, body]) =>
            [file, `sha256:${createHash("sha256").update(body).digest("hex")}`])),
        capture_scope: summary.capture_scope, window: summary.window, source_integrity: summary.source_integrity,
        clustering: summary.clustering, reconciliation: summary.reconciliation, reconciled: summary.reconciliation.status,
        truncated: null, live_reproduction_performed: false, permission_to_replay_or_write: false,
        omitted: [...OPTIONAL].filter((file) => !(file in files)).sort().map((file) => ({ file, reason: "not supplied" })),
        counts: { raw: summary.raw_volume, production_adjusted: summary.volume, clusters: summary.clusters.length,
            excluded_rows: 0 },
        ...changes,
    };
    const entries = Object.entries(files).map(([file, data]) => ({ name: `${ROOT}/${file}`, data }));
    entries.push({ name: `${ROOT}/manifest.json`, data: J(manifest) }, ...extra);
    const path = join(work, name);
    writeFileSync(path, createZip(entries));
    return path;
}

const withClusters = (files, edit) => {
    const clusters = JSON.parse(files["clusters.json"]);
    edit(clusters);
    const summary = JSON.parse(files["summary.json"]);
    summary.clusters = clusters;
    return { ...files, "clusters.json": J(clusters), "summary.json": J(summary) };
};

test("a valid archive passes and reports the bundle file set", () => {
    const result = inspectBundle(archive("valid.zip", makeFiles()));
    assert.equal(result.summary.volume.calls, 2);
    assert.equal(result.files.length, 10);
    assert.equal(result.manifest.bundle_id, ROOT);
});

test("archive size is checked before the ZIP directory is read", () => {
    const path = join(work, "oversized.zip");
    writeFileSync(path, "not a zip directory");
    assert.throws(() => inspectBundle(path, { limits: { maxArchiveBytes: 4 } }), /Archive file exceeds/);
    assert.throws(() => inspectBundle(path), BundleRefusedError);
});

test("track A requires a published successful control", () => {
    const files = withClusters(makeFiles(), ([item]) => {
        item.evidence_track = "A";
        item.evidence = { failing_frame_ids: item.frame_ids, control_frame_ids: [`f-${"2".repeat(24)}`],
            correlation_ids: ["trace-control"] };
    });
    assert.throws(() => inspectBundle(archive("missing-control.zip", files)), /Unresolved successful control/);
    const control = { ...JSON.parse(files["failures.jsonl"]), frame_id: `f-${"2".repeat(24)}`, call_id: "control",
        outcome: "ok", effective_outcome: "ok", status_code: 200, error_code: null, error: "", request_ids: ["trace-control"] };
    const accepted = inspectBundle(archive("with-control.zip", { ...files, "controls.jsonl": J(control) }));
    assert.equal(accepted.summary.volume.ok, 1);
});

test("rehashed forgeries and unsupported completeness claims are refused", () => {
    const forged = withClusters(makeFiles(), ([item]) => {
        item.signature = "forged unrelated diagnostic";
    });
    assert.throws(() => inspectBundle(archive("forged.zip", forged)), /Recomputed cluster/);
    const files = makeFiles();
    const summary = JSON.parse(files["summary.json"]);
    summary.capture_scope = "complete";
    Object.assign(summary.reconciliation, { status: true, expected_calls: 2, expected_host_failures: 1 });
    Object.assign(summary.payload_scan, { missing_nonfailed_payloads: 0, inconclusive_calls: 1 });
    Object.assign(summary.volume, { rate_available: true, fail_pct_of_known: 50.0, fail_pct_of_all: 50.0 });
    assert.throws(() => inspectBundle(archive("inconclusive.zip", { ...files, "summary.json": J(summary) })),
        /unsupported completeness/);
});

test("checksum, schema, daily-count, volume and duplicate-key violations are refused", () => {
    const files = makeFiles();
    const hashes = Object.fromEntries(Object.entries(files).map(([file, body]) =>
        [file, `sha256:${createHash("sha256").update(body).digest("hex")}`]));
    assert.throws(() => inspectBundle(archive("checksum.zip", { ...files, "report.md": "replaced" },
        { manifest: { checksums: hashes } })), /Checksum mismatch/);
    assert.throws(() => inspectBundle(archive("legacy.zip", files, { manifest: { schema_version: 1 } })), /Unsupported schema/);
    const days = JSON.parse(files["clusters.json"]);
    days[0].day_counts["2026-09-05"] = 3;
    assert.throws(() => inspectBundle(archive("days.zip", { ...files, "clusters.json": J(days) })), /daily counts/);
    const summary = JSON.parse(files["summary.json"]);
    summary.volume.fail = 0;
    assert.throws(() => inspectBundle(archive("volume.zip", { ...files, "summary.json": J(summary) })), /Volume outcomes/);
    assert.throws(() => inspectBundle(archive("dup-json.zip", { ...files, "environment.json": '{"a": 1, "a": 2}' })),
        /Duplicate JSON key/);
});

test("unsafe, duplicate and symlink members are refused without extraction", () => {
    const cases = [
        [{ name: "../escape", data: "x" }, /Unsafe archive path/],
        [{ name: "/absolute", data: "x" }, /Unsafe archive path/],
        [{ name: `${ROOT}\\escaped`, data: "x" }, /Unsafe archive member name/],
        [{ name: `${ROOT}/probe-results.json`, data: "/some/path", mode: 0o120777 }, /Unsupported archive member type/],
        [{ name: `${ROOT}/README.md`, data: "duplicate" }, /Duplicate archive member/],
    ];
    cases.forEach(([extra, reason], index) => {
        assert.throws(() => inspectBundle(archive(`bad-${index}.zip`, makeFiles(), { extra: [extra] })), reason, extra.name);
    });
});

test("per-file size bounds refuse instead of truncating", () => {
    const path = archive("large.zip", { ...makeFiles(), "report.md": "x".repeat(4097) });
    assert.throws(() => inspectBundle(path, { limits: { maxFileBytes: 4096 } }), /too large/);
    assert.equal(inspectBundle(path).files.length, 10);
});
