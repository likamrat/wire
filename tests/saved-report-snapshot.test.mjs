import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectSavedReportSnapshot } from "../lib/saved-report-snapshot.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function saved({ formats = ["json"], schemaVersion = 3 } = {}) {
    const snapshot = {
        schemaVersion, bundleId: "export-synthetic", promptMode: "none", formats,
        preparedAt: "2026-10-05T12:00:00.000Z", timeContext: { timeZone: "UTC", locale: "en-US" },
        dateSelection: { range: "capture" }, dateRange: {},
        records: [{ projectionVersion: 3, promptMode: "none", prompts: [], toolCalls: [] }],
    };
    const snapshotBytes = JSON.stringify(snapshot, null, 2) + "\n";
    const manifest = {
        schemaVersion, bundleId: snapshot.bundleId, promptMode: snapshot.promptMode, formats,
        preparedAt: snapshot.preparedAt, timeContext: snapshot.timeContext,
        dateSelection: snapshot.dateSelection, dateRange: snapshot.dateRange,
        privacyReview: { reviewerConfirmed: true, reviewerIdentityVerified: false },
        snapshotHash: hash(JSON.stringify(snapshot)),
        files: formats.includes("json") ? { "product-report.json": { sha256: hash(snapshotBytes), bytes: Buffer.byteLength(snapshotBytes) } } : {},
    };
    const manifestBytes = JSON.stringify(manifest);
    return { snapshot, manifest, manifestBytes, snapshotBytes, expectedManifestSha256: hash(manifestBytes) };
}

test("current saved JSON is verified without consulting current collection state", () => {
    const input = saved();
    const result = inspectSavedReportSnapshot(input);
    assert.equal(result.status, "supported");
    assert.equal(result.integrity, "matches-saved-manifest-and-file-hashes");
    assert.deepEqual(result.snapshot, input.snapshot);
    assert.equal(result.derivedReadOnly, true);
    assert.equal(result.overlapVerification, "not-established");
});

test("readable-only older reports remain valid artifacts but cannot reconstruct membership", () => {
    const input = saved({ formats: ["pdf", "html"] });
    const result = inspectSavedReportSnapshot({ manifestBytes: input.manifestBytes });
    assert.equal(result.status, "not-comparable");
    assert.equal(result.reason, "structured-snapshot-not-saved");
    assert.equal(result.snapshot, null);
});

test("declared JSON file missing differs from intentional PDF-only save", () => {
    const input = saved();
    const result = inspectSavedReportSnapshot({ manifestBytes: input.manifestBytes });
    assert.equal(result.status, "not-comparable");
    assert.equal(result.reason, "structured-snapshot-file-missing");
});

test("unapproved previews and missing disclosure attestations do not enter comparisons", () => {
    for (const privacyReview of [undefined, { reviewerConfirmed: false }, { reviewerConfirmed: "true" }]) {
        const input = saved();
        const result = inspectSavedReportSnapshot({
            manifestBytes: JSON.stringify({ ...input.manifest, privacyReview }),
            snapshotBytes: "Unreviewed contents must not even be parsed",
        });
        assert.equal(result.status, "not-comparable");
        assert.equal(result.reason, "disclosure-review-not-recorded");
        assert.equal(result.snapshot, null);
    }
});

test("unsupported schema remains unavailable rather than getting today's interpretation", () => {
    const result = inspectSavedReportSnapshot(saved({ schemaVersion: 2 }));
    assert.equal(result.status, "not-comparable");
    assert.equal(result.reason, "unsupported-snapshot-version");
    assert.equal(result.snapshot, null);
});

test("tampered JSON bytes fail the original saved file hash", () => {
    const input = saved();
    assert.throws(() => inspectSavedReportSnapshot({ ...input, snapshotBytes: input.snapshotBytes + " " }), /file hash/);
});

test("locally saved manifest fingerprint detects coordinated manifest edits", () => {
    const input = saved();
    input.manifest.bundleId = "export-replaced";
    assert.throws(() => inspectSavedReportSnapshot({ ...input, manifestBytes: JSON.stringify(input.manifest) }), /manifest hash/);
});

test("declared hashes alone are not described as origin authentication", () => {
    const input = saved();
    const result = inspectSavedReportSnapshot({ manifestBytes: input.manifestBytes, snapshotBytes: input.snapshotBytes });
    assert.equal(result.status, "supported");
    assert.equal(result.integrity, "matches-declared-hashes-only");
    assert.equal(result.overlapVerification, "not-established");
});

test("snapshot canonical hash protects the frozen facts, not JSON whitespace", () => {
    const input = saved();
    input.manifest.snapshotHash = "0".repeat(64);
    assert.throws(() => inspectSavedReportSnapshot({
        manifestBytes: JSON.stringify(input.manifest), snapshotBytes: input.snapshotBytes,
    }), /snapshot hash/);
});

test("matching hashes do not hide inconsistent identity or report choices", () => {
    const input = saved();
    input.manifest.promptMode = "original";
    assert.throws(() => inspectSavedReportSnapshot({
        manifestBytes: JSON.stringify(input.manifest), snapshotBytes: input.snapshotBytes,
    }), /promptMode/);
});

test("a valid different report cannot silently replace the selected report", () => {
    const input = saved();
    assert.throws(() => inspectSavedReportSnapshot({
        ...input, expectedBundleId: "export-another-synthetic",
    }), /selected bundle identity/);
    assert.equal(inspectSavedReportSnapshot({ ...input, expectedBundleId: input.snapshot.bundleId }).status, "supported");
});

test("missing identity, invalid date and malformed format inventory are not supported snapshots", () => {
    for (const patch of [{ bundleId: undefined }, { preparedAt: "not-a-date" }, { formats: [] }, { formats: ["json", "json"] }]) {
        const input = saved();
        assert.throws(() => inspectSavedReportSnapshot({
            manifestBytes: JSON.stringify({ ...input.manifest, ...patch }), snapshotBytes: input.snapshotBytes,
        }), /identity|preparation time|inventory/);
    }
});

test("malformed metadata and raw unprojected record shapes fail explicitly", () => {
    assert.throws(() => inspectSavedReportSnapshot({ manifestBytes: "{" }), /manifest.*JSON/i);
    assert.throws(() => inspectSavedReportSnapshot({ manifestBytes: "null" }), /manifest.*object/i);
    const input = saved();
    input.snapshot.records = [{ userPrompt: { text: "SYNTHETIC_UNPROJECTED" } }];
    input.snapshotBytes = JSON.stringify(input.snapshot);
    input.manifest.files["product-report.json"] = { sha256: hash(input.snapshotBytes), bytes: Buffer.byteLength(input.snapshotBytes) };
    input.manifest.snapshotHash = hash(JSON.stringify(input.snapshot));
    assert.throws(() => inspectSavedReportSnapshot({
        manifestBytes: JSON.stringify(input.manifest), snapshotBytes: input.snapshotBytes,
    }), /projected records/);
});
