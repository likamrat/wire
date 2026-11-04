import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { privateFixture } from "./helpers.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createNativeRetainedRead } from "../lib/native-retained-read.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { isNativeArtifactMutationAdmission, withNativeArtifactMutation } from "../lib/native-artifact-mutation.mjs";
import { isLocalActivityDeletionAdmission } from "../lib/local-activity-deletion-admission.mjs";

async function setup(t) {
    const cleanups = [];
    const { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const release = await acquireCollectorLock(context.dataDir);
    const transport = createMicrosoftNativeReadTransport({
        async open() {},
        async verifyAccount() {
            return { tenantId: "report-context-tenant", subjectId: "report-context-subject", knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 30 } });
    const persistence = await createNativePersistence(context, { lifecycle, transport });
    const access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
        acquireNative() { assert.fail("Report context checks cannot acquire source."); } });
    t.after(async () => {
        access.close(); persistence.close(); await lifecycle.close(); await release();
        for (const cleanup of cleanups) await cleanup();
    });
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const receipt = await lifecycle.command("native-report-context-owner", {
            action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
            ...(action === "microsoft-connect" ? { replace: false } : {}),
        }, () => true);
        assert.equal(receipt.outcome, "completed");
    }
    return { context, access, lifecycle, persistence };
}

test("report context ownership follows a genuine lifetime guard rather than a caller owner string", async t => {
    const app = await setup(t), owner = "native-report-stream-owner";
    const guard = await app.access.read(owner);
    const admission = { check() {}, dispatched() { assert.fail("The stream cannot write."); } };
    const context = app.access.nativeReportsFor(guard, admission);
    assert.equal(context.nativeReportSource, app.persistence.reportSource);
    assert.equal(context.nativeReportAdmission.owner, guard.owner);
    assert.notEqual(context.nativeReportAdmission.owner, owner);
    assert.throws(() => app.access.nativeReportsFor({ ...guard }, admission), { code: "wire_access_invalid_lease" });
    assert.throws(() => app.access.nativeReportsFor(guard, { ...admission, owner }), { code: "wire_access_invalid_request" });
    const shortRequest = await app.access.read("native-report-short-request");
    shortRequest.release();
    assert.equal(context.nativeReportAdmission.check(), true);
    await context.nativeReportSource.readSaved({ bundleIds: null }, context.nativeReportAdmission,
        (_state, entries) => assert.deepEqual(entries, []));
    app.access.releaseOwner(owner);
    assert.throws(() => context.nativeReportAdmission.check(), { code: "wire_access_revoked" });
    await assert.rejects(context.nativeReportSource.readSaved({ bundleIds: null }, context.nativeReportAdmission, () => []),
        { code: "wire_access_revoked" });
    assert.throws(() => app.access.nativeReportsFor(guard, admission), { code: "wire_access_revoked" });
});

test("versioned frames assert synchronously inside saved-report admission without queue reentry", async t => {
    const app = await setup(t), reader = app.access.nativeReader;
    const guard = await app.access.read("native-report-publication-owner");
    const context = app.access.nativeReportsFor(guard, { check() {}, dispatched() { assert.fail("Read-only."); } });
    const frame = await reader.scan();
    assert.equal(reader.assertCurrent(frame), true);
    assert.throws(() => reader.assertCurrent({ ...frame }), { code: "native-read-frame-invalid" });
    const acquired = await app.lifecycle.lease("microsoft-read");
    assert.throws(() => app.lifecycle.assertRetainedLeaseCurrent(acquired), { code: "invalid-request" });
    await context.nativeReportSource.readSaved({ bundleIds: null }, context.nativeReportAdmission, async () => {
        await Promise.resolve();
        assert.equal(reader.assertCurrent(frame), true);
        assert.equal(context.nativeReportAdmission.check(), true);
    });
    await app.persistence.configure({ expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 },
        { owner: "native-report-configuration-owner", check() {}, dispatched() {} });
    assert.throws(() => reader.assertCurrent(frame), { code: "native-read-stale" });
    reader.close();
    assert.throws(() => reader.assertCurrent(frame), { code: "wire_access_revoked" });
    guard.release();
});

test("synchronous checks reject unversioned and thenable hooks without source reads", async t => {
    const app = await setup(t);
    let reads = 0, asynchronousRevision = false;
    const source = async lease => { reads++; return app.persistence.readAuthorized(lease); };
    const unversioned = createNativeRetainedRead(app.lifecycle, source);
    t.after(() => unversioned.close());
    const unversionedFrame = await unversioned.scan(), before = reads;
    assert.throws(() => unversioned.assertCurrent(unversionedFrame), { code: "native-read-source-revision-unqualified" });
    assert.equal(reads, before);
    assert.equal(await unversioned.publish(unversionedFrame, () => "existing-publish"), "existing-publish");
    source.revision = lease => asynchronousRevision
        ? Promise.reject(new Error("Example asynchronous revision.")) : app.persistence.readAuthorized.revision(lease);
    const versioned = createNativeRetainedRead(app.lifecycle, source);
    t.after(() => versioned.close());
    const frame = await versioned.scan(), count = reads;
    asynchronousRevision = true;
    assert.throws(() => versioned.assertCurrent(frame), { code: "native-read-source-revision-unqualified" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, count);
});

test("local activity deletion authority is derived from genuine original WIRE request guards only", async t => {
    const app = await setup(t), owner = "native-local-deletion-owner";
    const guard = await app.access.read(owner), foreign = await app.access.read("foreign-local-deletion-owner");
    t.after(() => { guard.release(); foreign.release(); });
    const admission = { check() {}, dispatched() { assert.fail("Preview must not dispatch deletion."); } };
    await assert.rejects(app.access.localActivityDeletionFor({ ...guard }, admission), { code: "wire_access_invalid_lease" });
    await assert.rejects(app.access.localActivityDeletionFor(guard, { ...admission, owner }), { code: "wire_access_invalid_request" });
    const local = await app.access.localActivityDeletionFor(guard, admission);
    const deletion = createDeletionController(app.context, { requireAdmission: true });
    await assert.rejects(deletion.preview(guard.owner, { scope: "all" }, { ...local }),
        { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" });
    await assert.rejects(deletion.preview(foreign.owner, { scope: "all" }, local),
        { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" });
    assert.ok((await deletion.preview(guard.owner, { scope: "all" }, local)).operationId);
    guard.release();
    await assert.rejects(deletion.preview(guard.owner, { scope: "all" }, local), { code: "wire_access_revoked" });
});

test("runtime saved-artifact guards are distinct from local activity and derive only the genuine original owner", async t => {
    const app = await setup(t), guard = await app.access.read("artifact-request-owner");
    t.after(() => guard.release());
    const admission = { check() {}, dispatched() {} };
    await assert.rejects(app.access.nativeArtifactMutationFor({ ...guard }, admission), { code: "wire_access_invalid_lease" });
    await assert.rejects(app.access.nativeArtifactMutationFor(guard, { ...admission, owner: "borrowed-artifact-owner" }),
        { code: "wire_access_invalid_request" });
    const artifact = await app.access.nativeArtifactMutationFor(guard, admission);
    const local = await app.access.localActivityDeletionFor(guard, admission);
    assert.equal(isNativeArtifactMutationAdmission(artifact, app.context, guard.owner), true);
    assert.equal(isNativeArtifactMutationAdmission({ ...artifact }, app.context, guard.owner), false);
    assert.equal(isNativeArtifactMutationAdmission(local, app.context, guard.owner), false);
    assert.equal(isLocalActivityDeletionAdmission(artifact, app.context, guard.owner), false);
    assert.equal(isNativeArtifactMutationAdmission(artifact, app.context, "borrowed-artifact-owner"), false);
    guard.release();
    await assert.rejects(withNativeArtifactMutation(artifact, app.context, guard.owner,
        { scope: { scope: "all-reports" }, membership: null, readOnly: true }, () => assert.fail("Released request cannot enter")),
    { code: "wire_access_revoked" });
});
