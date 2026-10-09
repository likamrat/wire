import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateFixture } from "./helpers.mjs";
import { updateBoardState, loadBoardState } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { deletionHash, activityDeletionVersion } from "../lib/deletion-identities.mjs";
import { createSavedArtifactDescriptor, savedArtifact, describeSavedArtifact } from "../lib/report-artifacts.mjs";
import { migratePrivateData } from "../lib/migration.mjs";

async function artifactsFixture(t, { backup = false, large = false } = {}) {
    const { context: original, root } = await privateFixture(t);
    const reports = [`export-${randomUUID()}`, `export-${randomUUID()}`], comparison = `export-${randomUUID()}`;
    const entries = [];
    for (const [index, bundleId] of [...reports, comparison].entries()) {
        const kind = index === 2 ? "comparison" : "report", prefix = kind === "report" ? "product-report" : "comparison-report";
        const folder = path.join(original.dataDir, "exports", bundleId, "files");
        await mkdir(folder, { recursive: true });
        const snapshotHash = deletionHash(`SYNTHETIC_SNAPSHOT_${index}`);
        const contents = {
            [`${prefix}.html`]: `SYNTHETIC_SAVED_${index}`,
            [`${prefix}.json`]: JSON.stringify({ synthetic: true, snapshotHash }),
            [`${prefix}.md`]: `SYNTHETIC_MARKDOWN_${index}`,
            [`${prefix}.pdf`]: large && index === 0 ? Buffer.alloc(33 * 1024 ** 2, 42) : Buffer.from(`SYNTHETIC_BINARY_${index}`),
            "coverage-and-redaction-manifest.json": JSON.stringify({ bundleId, snapshotHash, privacyReview: { reviewerConfirmed: true } }),
        };
        for (const [name, bytes] of Object.entries(contents)) await writeFile(path.join(folder, name), bytes);
        entries.push({
            bundleId, kind, bundleDir: folder, formats: ["html", "json", "markdown", "pdf"], snapshotHash,
            files: Object.fromEntries(Object.keys(contents).map(name => [name, path.join(folder, name)])),
            ...(kind === "comparison" ? { sourceReports: reports.map((id, n) => ({ bundleId: id, snapshotHash: deletionHash(`SYNTHETIC_SNAPSHOT_${n}`) })) } : {}),
        });
    }
    await updateBoardState(original, state => { state.exports.push(...entries); });
    let context = original, managedBackup;
    if (backup) {
        const inputs = path.join(root, "inputs");
        await mkdir(inputs);
        await writeFile(path.join(inputs, "app-inventory.json"), "[]");
        await writeFile(path.join(inputs, "history-window.json"), '{"windowDays":30}');
        const migrated = await migratePrivateData({ source: original.dataDir, destination: path.join(root, "maintained"), importFiles: inputs,
            sessionRoot: path.join(root, "synthetic-sources"), appDbPath: path.join(root, "synthetic.db") });
        context = { dataDir: migrated.destination };
        managedBackup = migrated.backup;
    }
    return { context, original, reports, comparison, managedBackup, before: await loadBoardState(context) };
}

test("individual report deletion removes its large managed bundle/copies/index, preserving source, other reports and frozen comparisons", { timeout: 30000 }, async t => {
    const { context, original, reports, comparison, managedBackup, before } = await artifactsFixture(t, { backup: true, large: true });
    const controller = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context) });
    const retained = before.exports.filter(entry => entry.bundleId !== reports[0]);
    const hashes = new Map();
    for (const entry of retained) for (const file of Object.values(entry.files)) hashes.set(file, deletionHash(await readFile(file)));
    const preview = await controller.previewArtifact("panel", { artifactKind: "report", artifactId: reports[0] });
    assert.equal(preview.counts.managedFiles, 10);
    assert.equal(preview.counts.managedCopies, 2);
    assert.equal(preview.counts.savedDependentComparisons, 1);
    assert.equal((await loadBoardState(context)).exports.length, 3, "Preview is not deletion");
    const result = await controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    const state = await loadBoardState(context);
    assert.throws(() => savedArtifact(state, reports[0]), { status: 404 });
    for (const file of Object.values(before.exports[0].files)) await assert.rejects(access(file), { code: "ENOENT" });
    for (const file of Object.values(before.exports[0].files)) await assert.rejects(access(path.join(managedBackup, path.relative(context.dataDir, file))), { code: "ENOENT" });
    assert.deepEqual(state.evidence, before.evidence);
    assert.ok(Number.isSafeInteger(before.evidenceRevision));
    assert.equal(state.evidenceRevision, before.evidenceRevision);
    assert.deepEqual(state.cards, before.cards);
    assert.equal(activityDeletionVersion(state), 0, "Artifact removal is not a source-identity purge");
    for (const [file, hash] of hashes) assert.equal(deletionHash(await readFile(file)), hash);
    assert.equal(describeSavedArtifact(savedArtifact(state, comparison), state).sourceReports[0].available, false);
    assert.equal((await loadBoardState({ dataDir: managedBackup })).exports.some(entry => entry.bundleId === reports[0]), false);
    assert.equal((await loadBoardState(original)).exports.length, 3, "Never follow an external migration source");
    const comparisonPreview = await controller.previewArtifact("panel", { artifactKind: "comparison", artifactId: comparison });
    await controller.confirmArtifact("panel", { operationId: comparisonPreview.operationId, confirmed: true });
    assert.deepEqual((await loadBoardState(context)).exports.map(entry => entry.bundleId), [reports[1]]);
});

test("artifact receipts recover with a read-only token after restart, and partial cleanup never replays a new delete", async t => {
    const { context, reports, before } = await artifactsFixture(t);
    const file = before.exports[0].files["product-report.pdf"], original = await readFile(file);
    const describe = createSavedArtifactDescriptor(context);
    const controller = createDeletionController(context, { describeSavedArtifact: describe,
        afterSeal: () => writeFile(file, "SYNTHETIC_CHANGED_AFTER_SEAL"),
    });
    const preview = await controller.previewArtifact("original-panel", { artifactKind: "report", artifactId: reports[0] });
    await assert.rejects(controller.confirmArtifact("wrong-panel", { operationId: preview.operationId, confirmed: true }), { status: 409 });
    await assert.rejects(controller.confirmArtifact("original-panel", { operationId: preview.operationId, confirmed: true }), /changed/);
    await assert.rejects(access(before.exports[0].files["product-report.html"]), { code: "ENOENT" });
    assert.equal((await controller.status(preview.operationId, "original-panel")).phase, "pending");
    await assert.rejects(controller.status(preview.operationId, "new-panel"), { status: 403 });
    await assert.rejects(controller.status(preview.operationId, "new-panel", "0".repeat(64)), { status: 403 });
    const pending = await controller.status(preview.operationId, "new-panel", preview.receiptToken);
    assert.equal(pending.phase, "pending");
    assert.equal(pending.receiptHash, undefined);
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence, "Unrelated source reads remain available");
    await writeFile(file, original);
    const restarted = createDeletionController(context, { describeSavedArtifact: describe });
    await restarted.recover();
    assert.equal((await restarted.status(preview.operationId, "new-panel", preview.receiptToken)).phase, "complete");
    await assert.rejects(restarted.confirmArtifact("new-panel", { operationId: preview.operationId, confirmed: true }), { status: 403 });
    assert.equal((await restarted.confirmArtifact("original-panel", { operationId: preview.operationId, confirmed: true })).phase, "complete");
    assert.equal((await loadBoardState(context)).exports.length, 2);
});

test("legacy root-layout artifacts and stranded index copies delete without rewriting unrelated staged source data", async t => {
    const { context } = await privateFixture(t);
    const bundleId = `export-${randomUUID()}`, folder = path.join(context.dataDir, "exports", bundleId);
    await mkdir(folder);
    const files = {};
    for (const name of ["report.md", "evidence.json", "manifest.json"]) {
        files[name] = path.join(folder, name);
        await writeFile(files[name], `SYNTHETIC_LEGACY_${name}`);
    }
    await updateBoardState(context, state => { state.exports.push({ bundleId, bundleDir: folder, files }); });
    const before = await loadBoardState(context);
    const staging = path.join(context.dataDir, "deletion-staging", randomUUID());
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "0.json"), JSON.stringify(before));
    const sourceCopy = JSON.stringify({ records: before.evidence });
    await writeFile(path.join(staging, "1.json"), sourceCopy);
    const controller = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context) });
    const preview = await controller.previewArtifact("panel", { artifactKind: "report", artifactId: bundleId });
    assert.equal(preview.counts.managedFiles, 3);
    await controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true });
    for (const file of Object.values(files)) await assert.rejects(access(file), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(path.join(staging, "0.json"))).exports, []);
    assert.equal(await readFile(path.join(staging, "1.json"), "utf8"), sourceCopy);
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
});

test("all-report deletion seals logical membership once and preserves newer reports, comparisons, activity and managed indexes", async t => {
    const { context, reports, comparison, managedBackup, before } = await artifactsFixture(t, { backup: true });
    const controller = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context) });
    const preview = await controller.previewArtifact("panel", { scope: "all-reports" });
    assert.equal(preview.scope, "all-reports");
    assert.deepEqual(preview.artifacts.map(item => item.artifactId), reports);
    assert.equal(preview.counts.reports, 2, "A bundle counts once, not once per format/copy");
    assert.equal(preview.counts.managedFiles, 20);
    assert.equal(preview.counts.savedDependentComparisons, 1, "Shared comparisons count once");
    assert.equal(preview.counts.savedComparisons, 1);
    assert.deepEqual((await loadBoardState(context)).exports, before.exports, "Preview is read-only");
    const retainedBytes = await Promise.all(Object.values(before.exports[2].files).map(file => readFile(file)));
    const newer = `export-${randomUUID()}`;
    await updateBoardState(context, state => { state.exports.push({ bundleId: newer, kind: "report", files: {} }); });
    const result = await controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    assert.deepEqual(result.artifacts, preview.artifacts);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports.map(entry => entry.bundleId), [comparison, newer], "Unreviewed new reports are not swept in");
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.equal(activityDeletionVersion(after), activityDeletionVersion(before));
    assert.deepEqual(await Promise.all(Object.values(before.exports[2].files).map(file => readFile(file))), retainedBytes);
    assert.deepEqual((await loadBoardState({ dataDir: managedBackup })).exports.map(entry => entry.bundleId), [comparison]);
    for (const entry of before.exports.slice(0, 2)) for (const file of Object.values(entry.files)) {
        await assert.rejects(access(file), { code: "ENOENT" });
        await assert.rejects(access(path.join(managedBackup, path.relative(context.dataDir, file))), { code: "ENOENT" });
    }
    assert.deepEqual(await controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true }), result);
});

test("bulk previews fail closed for cancelled, expired, changed or broadened scope and recover only the sealed batch", async t => {
    const { context, reports, comparison, before } = await artifactsFixture(t);
    let clock = Date.now();
    const descriptor = createSavedArtifactDescriptor(context);
    const controller = createDeletionController(context, { describeSavedArtifact: descriptor, now: () => clock });
    for (const scope of [{ scope: "all" }, { scope: "all-reports", query: "masked" }, { scope: "all-reports", artifactId: reports[0] }]) {
        await assert.rejects(controller.previewArtifact("panel", scope), { status: 422 });
    }
    let preview = await controller.previewArtifact("panel", { scope: "all-reports" });
    controller.cancel("panel", preview.operationId);
    await assert.rejects(controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true }), { status: 409 });
    preview = await controller.previewArtifact("panel", { scope: "all-reports" });
    clock += 120001;
    await assert.rejects(controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true }), { status: 409 });
    preview = await controller.previewArtifact("panel", { scope: "all-reports" });
    const file = before.exports[1].files["product-report.pdf"], original = await readFile(file);
    await writeFile(file, "SYNTHETIC_CHANGED_BEFORE_CONFIRMATION");
    await assert.rejects(controller.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true }), { status: 409 });
    assert.deepEqual((await loadBoardState(context)).exports, before.exports, "Stale batch does not remove any index entries");
    for (const entry of before.exports) for (const file of Object.values(entry.files)) await access(file);
    await writeFile(file, original);
    const interrupted = createDeletionController(context, {
        describeSavedArtifact: descriptor, afterSeal: () => writeFile(file, "SYNTHETIC_CHANGED_AFTER_SEAL"),
    });
    preview = await interrupted.previewArtifact("panel", { scope: "all-reports" });
    await assert.rejects(interrupted.confirmArtifact("panel", { operationId: preview.operationId, confirmed: false }), { status: 422 });
    await assert.rejects(interrupted.confirmArtifact("other-panel", { operationId: preview.operationId, confirmed: true }), { status: 409 });
    await assert.rejects(interrupted.confirmArtifact("panel", { operationId: preview.operationId, confirmed: true }), /incomplete/);
    assert.equal((await interrupted.status(preview.operationId, "panel")).phase, "pending");
    const sealed = await loadBoardState(context);
    assert.deepEqual(sealed.exports.map(entry => entry.bundleId), [comparison], "Logical removal seals together; disk cleanup can be partial");
    assert.deepEqual(sealed.evidence, before.evidence);
    await assert.rejects(interrupted.previewArtifact("panel", { scope: "all-reports" }), { status: 409 });
    await assert.rejects(interrupted.status(preview.operationId, "other-panel", "0".repeat(64)), { status: 403 });
    const restarted = createDeletionController(context, { describeSavedArtifact: descriptor });
    await assert.rejects(restarted.recover(), /incomplete/);
    await writeFile(file, original);
    await restarted.recover();
    const result = await restarted.status(preview.operationId, "new-panel", preview.receiptToken);
    assert.equal(result.phase, "complete");
    assert.equal(result.receiptHash, undefined);
    await assert.rejects(restarted.previewArtifact("panel", { scope: "all-reports" }), { status: 422 });
    for (const entry of before.exports.slice(0, 2)) for (const file of Object.values(entry.files)) await assert.rejects(access(file), { code: "ENOENT" });
});
