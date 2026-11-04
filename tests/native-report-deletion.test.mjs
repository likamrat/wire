import test from "node:test";
import assert from "node:assert/strict";
import { createExportController } from "../lib/export.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { describeSavedArtifact } from "../lib/report-artifacts.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { fixture } from "./helpers.mjs";
import { committedNativeReportFixture, savedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import filesystem, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { withNativeArtifactMutation } from "../lib/native-artifact-mutation.mjs";

test("native mixed-bulk deletion refuses before any descriptor; frozen GH-only membership does not expand", async t => {
    const app = await committedNativeReportFixture(t);
    await replaceEvidence(app.context, () => ({ records: [fixture("github-only")], importCoverage: {} }));
    const exports = createExportController(app.context);
    async function save(selection) {
        const state = await loadBoardState(app.context);
        const preview = await exports.preview(app.owner, undefined, { formats: ["html"], promptMode: "none" },
            { ...selection, revision: state.revision }, undefined, app.services);
        await exports.review(app.owner, preview.previewId, true, undefined, app.services);
        return (await exports.confirm(app.owner, preview.previewId, true, undefined, app.services)).bundle;
    }
    const github = await save({ kind: "selected", scenarioIds: ["github-only"] });
    const described = [], descriptor = createSavedArtifactDescriptor(app.context);
    const deletion = createDeletionController(app.context, { describeSavedArtifact: (state, scope) => {
        described.push(scope.artifactId);
        return descriptor(state, scope);
    } });
    const originalBatch = await deletion.previewArtifact(app.owner, { scope: "all-reports" });
    assert.deepEqual(described, [github.bundleId]);
    const { bundle: native } = await savedNativeReportFixture(app, { formats: ["html"], promptMode: "none" }, { github: true });
    described.length = 0;
    await assert.rejects(deletion.previewArtifact(app.owner, { scope: "all-reports" }),
        { status: 503, code: "NATIVE_REPORT_DELETION_UNAVAILABLE" });
    assert.deepEqual(described, [], "GH ordered before a hidden native entry must not trigger any descriptor/file traversal.");
    await assert.rejects(deletion.previewArtifact(app.owner, { artifactKind: "report", artifactId: native.bundleId }),
        { status: 503, code: "NATIVE_REPORT_DELETION_UNAVAILABLE" });
    assert.deepEqual(described, []);
    await assert.rejects(deletion.confirmArtifact(app.owner, { operationId: originalBatch.operationId, confirmed: true }), { status: 409 });
    assert.deepEqual(described, [github.bundleId], "Later native reports do not broaden the frozen GH-only batch.");
    described.length = 0;
    const exact = await deletion.previewArtifact(app.owner, { artifactKind: "report", artifactId: github.bundleId });
    assert.deepEqual(described, [github.bundleId]);
    await deletion.confirmArtifact(app.owner, { operationId: exact.operationId, confirmed: true });
    const current = await loadBoardState(app.context);
    assert.deepEqual(current.exports.map(entry => entry.bundleId), [native.bundleId]);
    assert.equal(current.stateVersion, 5);
    assert.equal(current.nativeReportPolicy, "native-report-account-bound-v1");
});

for (const interrupted of [false, true]) test(`native artifact controller uses its distinct admission and preserves sealed recovery (interrupted=${interrupted})`, async t => {
    const app = await committedNativeReportFixture(t), saved = await savedNativeReportFixture(app, { formats: ["html", "json"], promptMode: "none" });
    const before = await loadBoardState(app.context), scope = { artifactKind: "report", artifactId: saved.bundle.bundleId };
    let dispatches = 0, seals = 0, descriptorCalls = 0, escaped;
    const request = { ...app.services.nativeReportAdmission, dispatched() { dispatches++; } };
    const guard = await app.persistence.reportSource.artifactMutationAdmission(request);
    const descriptor = createSavedArtifactDescriptor(app.context);
    const controller = createDeletionController(app.context, {
        describeSavedArtifact: async (state, target, authorization) => {
            escaped = authorization; descriptorCalls++;
            const entry = state.exports.find(item => item.bundleId === target.artifactId);
            assert.equal(describeSavedArtifact(entry, state, { authorization, session: app.context }).canDelete, true);
            return descriptor(state, target, authorization);
        },
        async onSeal(state, operation) {
            seals++;
            assert.equal(state.exports.some(entry => entry.bundleId === scope.artifactId), false);
            assert.equal(operation.phase, "pending");
            assert.ok((await readFile(saved.bundle.files["product-report.html"])).length, "Invalidation precedes cleanup.");
            if (interrupted) throw new Error("Interrupted after qualified artifact seal");
        },
    });
    await assert.rejects(controller.previewArtifact(app.owner, scope, { ...guard }), { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    assert.equal(descriptorCalls, 0);
    const preview = await controller.previewArtifact(app.owner, scope, guard);
    assert.equal(dispatches, 0);
    assert.doesNotMatch(JSON.stringify(preview), /nativeSourceBinding|nativeArtifactAdmission|artifactBinding/);
    await assert.rejects(descriptor(before, scope, escaped), { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    await assert.rejects(controller.confirmArtifact(app.owner, { operationId: preview.operationId, confirmed: true }), { status: 403 });
    const completion = controller.confirmArtifact(app.owner, { operationId: preview.operationId, confirmed: true }, guard);
    if (interrupted) await assert.rejects(completion, /Interrupted after qualified artifact seal/);
    else assert.equal((await completion).phase, "complete");
    assert.equal(dispatches, 1);
    assert.equal(seals, 1);
    const reader = createDeletionController(app.context);
    const pending = await reader.status(preview.operationId, app.owner);
    assert.equal(pending.phase, interrupted ? "pending" : "complete");
    assert.doesNotMatch(JSON.stringify(pending), /nativeArtifactAdmission|nativeSourceBinding/);
    await reader.recover();
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.nativeRetention, before.nativeRetention);
    assert.equal(after.nativeReportPolicy, before.nativeReportPolicy);
    assert.equal(after.stateVersion, before.stateVersion);
    for (const file of Object.values(saved.bundle.files)) await assert.rejects(readFile(file), { code: "ENOENT" });
    const repeated = await controller.confirmArtifact(app.owner, { operationId: preview.operationId, confirmed: true }, guard);
    assert.equal(repeated.phase, "complete");
    assert.equal(dispatches, 1, "Confirmation replay can only return the original sealed outcome.");
});

test("native artifact bulk admission rejects a foreign member before any descriptor", async t => {
    const app = await committedNativeReportFixture(t), saved = await savedNativeReportFixture(app, { formats: ["html"] });
    const guard = await app.persistence.reportSource.artifactMutationAdmission(app.services.nativeReportAdmission);
    let calls = 0;
    const controller = createDeletionController(app.context, { describeSavedArtifact() { calls++; assert.fail("Foreign scope must not walk files"); } });
    await updateBoardState(app.context, state => { state.exports[0].nativeSourceBinding.account = "0".repeat(64); });
    await assert.rejects(controller.previewArtifact(app.owner, { scope: "all-reports" }, guard), { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    assert.equal(calls, 0);
    assert.ok((await readFile(saved.bundle.files["product-report.html"])).length);
});

test("native descriptor rechecks original admission immediately after asynchronous path metadata", async t => {
    const app = await committedNativeReportFixture(t), saved = await savedNativeReportFixture(app, { formats: ["html"] });
    const scope = { artifactKind: "report", artifactId: saved.bundle.bundleId };
    let revoked = false, reads = 0;
    const request = { ...app.services.nativeReportAdmission, check: () => !revoked };
    const guard = await app.persistence.reportSource.artifactMutationAdmission(request);
    const original = filesystem.lstat;
    const mock = t.mock.method(filesystem, "lstat", async (...args) => {
        const result = await original(...args);
        reads++; revoked = true;
        return result;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(withNativeArtifactMutation(guard, app.context, app.owner, { scope, membership: null, readOnly: true },
            (state, authorization) => createSavedArtifactDescriptor(app.context)(state, scope, authorization)),
        { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
        assert.equal(reads, 1);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal((await loadBoardState(app.context)).exports.length, 1);
});

test("changed native artifact bytes invalidate the original controller preview before mutation dispatch", async t => {
    const app = await committedNativeReportFixture(t), saved = await savedNativeReportFixture(app, { formats: ["html"] });
    let dispatches = 0;
    const request = { ...app.services.nativeReportAdmission, dispatched() { dispatches++; } };
    const guard = await app.persistence.reportSource.artifactMutationAdmission(request);
    const controller = createDeletionController(app.context, { describeSavedArtifact: createSavedArtifactDescriptor(app.context) });
    const preview = await controller.previewArtifact(app.owner, { artifactKind: "report", artifactId: saved.bundle.bundleId }, guard);
    const file = saved.bundle.files["product-report.html"], bytes = await readFile(file);
    await filesystem.writeFile(file, Buffer.concat([bytes, Buffer.from("\n")]));
    await assert.rejects(controller.confirmArtifact(app.owner, { operationId: preview.operationId, confirmed: true }, guard), { status: 409 });
    assert.equal(dispatches, 0);
    const state = await loadBoardState(app.context);
    assert.equal(state.exports.length, 1);
    assert.equal(state.deletion?.pending, undefined);
});
