import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateFixture } from "./helpers.mjs";
import { createSavedArtifactDescriptor, validateSavedSources, describeSavedArtifact } from "../lib/report-artifacts.mjs";
import { artifactDeletionKey } from "../lib/deletion-identities.mjs";

async function artifact(context, { legacy = false, kind = "report" } = {}) {
    const bundleId = `export-${randomUUID()}`;
    const bundleDir = path.join(context.dataDir, "exports", bundleId, ...(legacy ? [] : ["files"]));
    await mkdir(bundleDir, { recursive: true });
    const names = legacy ? ["legacy-summary.md", "manifest.json"] : [`${kind === "comparison" ? "comparison-report" : "product-report"}.html`, "coverage-and-redaction-manifest.json"];
    const files = {};
    for (const name of names) {
        files[name] = path.join(bundleDir, name);
        await writeFile(files[name], `Synthetic ${name}`);
    }
    return { bundleId, bundleDir, kind, files, snapshotHash: "a".repeat(64), formats: ["html"] };
}

test("modern and registered legacy-root bundles produce sealed path-free inventories", async t => {
    const { context } = await privateFixture(t);
    const modern = await artifact(context), legacy = await artifact(context, { legacy: true });
    const state = { exports: [modern, legacy] }, describe = createSavedArtifactDescriptor(context);
    const current = await describe(state, { artifactKind: "report", artifactId: modern.bundleId });
    const older = await describe(state, { artifactKind: "report", artifactId: legacy.bundleId });
    assert.equal(current.layout, "files");
    assert.equal(older.layout, "bundle-root");
    assert.equal(current.files.length, 2);
    assert.equal(older.files.length, 2);
    assert.match(current.manifestHash, /^[a-f0-9]{64}$/);
    assert.equal(older.manifestHash, null);
    assert.match(older.inventoryHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify([current, older]).includes(context.dataDir));
});

test("descriptor discloses retained dependent comparisons without removing them", async t => {
    const { context } = await privateFixture(t);
    const report = await artifact(context), comparison = await artifact(context, { kind: "comparison" });
    comparison.sourceReports = [{ bundleId: report.bundleId, snapshotHash: report.snapshotHash }];
    const state = { exports: [report, comparison] }, before = structuredClone(state);
    const described = await createSavedArtifactDescriptor(context)(state, { artifactKind: "report", artifactId: report.bundleId });
    assert.deepEqual(described.dependentComparisons, [{ bundleId: comparison.bundleId }]);
    assert.equal(describeSavedArtifact(report, state).retainedComparisonCount, 1);
    assert.deepEqual(state, before);
});

test("artifact descriptors reject forged paths and kind confusion", async t => {
    const { context } = await privateFixture(t);
    const report = await artifact(context);
    const describe = createSavedArtifactDescriptor(context), state = { exports: [report] };
    await assert.rejects(describe(state, { artifactKind: "comparison", artifactId: report.bundleId }), /no longer available/);
    report.files["product-report.html"] = path.join(context.dataDir, "unrelated.html");
    await assert.rejects(describe(state, { artifactKind: "report", artifactId: report.bundleId }), /outside its registered bundle/);
});

test("locked-state saved source guard rejects deleted or changed sources", () => {
    const first = { bundleId: `export-${randomUUID()}`, snapshotHash: "a".repeat(64), kind: "report" };
    const second = { bundleId: `export-${randomUUID()}`, snapshotHash: "b".repeat(64), kind: "report" };
    const sources = [first, second].map(({ bundleId, snapshotHash }) => ({ bundleId, snapshotHash }));
    assert.equal(validateSavedSources({ exports: [first, second] }, sources), true);
    assert.throws(() => validateSavedSources({ exports: [second] }, sources), /no longer available/);
    assert.throws(() => validateSavedSources({ exports: [{ ...first, snapshotHash: "c".repeat(64) }, second] }, sources), /changed or was deleted/);
    assert.throws(() => validateSavedSources({
        exports: [first, second], artifactDeletion: { schemaVersion: 1, revision: 1, identities: [artifactDeletionKey("report", first.bundleId)] },
    }, sources), /no longer available/);
});

test("report choice metadata projects only a known saved request-group count", () => {
    const entry = { bundleId: `export-${randomUUID()}`, kind: "report", formats: ["html"], promptMode: "none",
        selectionScope: { requestGroups: 3, scenarioIds: ["private-source-id"], query: "private-search" } };
    const descriptor = describeSavedArtifact(entry, { exports: [entry] });
    assert.equal(descriptor.requestGroupCount, 3);
    assert.doesNotMatch(JSON.stringify(descriptor), /private-source-id|private-search/);
    for (const requestGroups of [undefined, null, -1, "3"]) {
        const unknown = describeSavedArtifact({ ...entry, selectionScope: { requestGroups } }, { exports: [] });
        assert.equal(Object.hasOwn(unknown, "requestGroupCount"), false);
    }
    for (const nativeConversations of [0, 2]) {
        const known = describeSavedArtifact({ ...entry, selectionScope: { requestGroups: 3, nativeConversations } }, { exports: [] });
        assert.equal(known.nativeConversationCount, nativeConversations);
        assert.equal(known.requestGroupCount, 3);
    }
    for (const nativeConversations of [undefined, null, -1, 0.5, "2"]) {
        const unknown = describeSavedArtifact({ ...entry, selectionScope: { nativeConversations } }, { exports: [] });
        assert.equal(Object.hasOwn(unknown, "nativeConversationCount"), false);
    }
});

test("native report deletion is refused before reading its file inventory and advertised unavailable", async t => {
    const { context } = await privateFixture(t);
    const native = { bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64), formats: ["html"] };
    Object.defineProperty(native, "files", { get() { assert.fail("Native deletion must not walk any files"); } });
    await assert.rejects(createSavedArtifactDescriptor(context)({ exports: [native] },
        { artifactKind: "report", artifactId: native.bundleId }), { status: 503, code: "NATIVE_REPORT_DELETION_UNAVAILABLE" });
    assert.equal(describeSavedArtifact({ ...native }, { exports: [] }).canDelete, false);
});

test("a hidden native comparison dependency cannot trigger file walks or reveal its identity through a GitHub descriptor", async t => {
    const { context } = await privateFixture(t);
    const github = { bundleId: `export-${randomUUID()}`, kind: "report" };
    const dependent = { bundleId: `export-${randomUUID()}`, kind: "comparison", nativeEvidenceHash: "b".repeat(64),
        sourceReports: [{ bundleId: github.bundleId }] };
    assert.equal(describeSavedArtifact(github, { exports: [github, dependent] }).canDelete, false);
    for (const item of [github, dependent]) Object.defineProperty(item, "files", { get() { assert.fail("No dependency files may be walked"); } });
    await assert.rejects(createSavedArtifactDescriptor(context)({ exports: [github, dependent] },
        { artifactKind: "report", artifactId: github.bundleId }), error => {
            assert.equal(error.code, "NATIVE_REPORT_DELETION_UNAVAILABLE");
            assert.ok(!error.message.includes(dependent.bundleId));
            return true;
        });
});
