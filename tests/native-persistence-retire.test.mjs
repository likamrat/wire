import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOARD_ID } from "../lib/evidence.mjs";
import { loadBoardState, updateBoardState, replaceEvidence, exclusiveBoard, readPrivateEvidenceBytes, stagePrivateEvidence, writeExclusive } from "../lib/store.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence, readNativeCollectionSettings, readGlobalCollectionGate, isNativeReportSource, assertNativeReportRuntime } from "../lib/native-persistence.mjs";
import { projectRetainedNativeRecords, projectRetainedNativeEntries } from "../lib/retained-population.mjs";
import { validateNativeReportState, validateNativeStorageState } from "../lib/native-retention-state.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { encodeNativeRetainedCapture, mergeNativeRetainedCapture, validateNativeRetainedDocument,
    filterNativeRetainedCapture } from "../lib/native-retention-contract.mjs";
import { openNativeSegmentedReader } from "../lib/native-segmented-read.mjs";
import { nativeCallsSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { nativeReportSelectionExpectations, assertNativeReportSelection } from "../lib/native-report-selection.mjs";
import { NATIVE_RETAINED_CONTRACT, retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { stageNativeV1Capture } from "../lib/native-segmented-v1.mjs";
import { nativeSegmentedEnvelope, encodeNativeSegmentedBlock } from "../lib/native-segmented-codec.mjs";
import { nativeV1SegmentedRows } from "../lib/native-segmented-v1.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { artifactDeletionPlan, stageDeletion, finishDeletionFiles } from "../lib/deletion-storage.mjs";
import { deletionHash } from "../lib/deletion-identities.mjs";
import { withNativeArtifactMutation, assertNativeArtifactMutation, nativeArtifactMutationBinding,
    bindNativeArtifactMutationPlan, dispatchNativeArtifactMutation, sealNativeArtifactMutation,
    completeNativeArtifactMutation } from "../lib/native-artifact-mutation.mjs";
import { projectNativeReportEvidence } from "../lib/native-report-evidence.mjs";
import { currentReportPresentation } from "../lib/report-presentation.mjs";
import { normalizeReportOptions } from "../lib/prompt-projection.mjs";
import { time } from "../lib/time.mjs";

async function setup(t, { connect = true, verifyAccount } = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "wire-native-retire-"));
    const context = { dataDir };
    await loadBoardState(context);
    const release = await acquireCollectorLock(dataDir);
    const transport = createMicrosoftNativeReadTransport({
        open: async () => {},
        verifyAccount: verifyAccount ?? (async () => ({
            tenantId: "example-tenant", subjectId: "example-subject", knownAccountMatched: true, chat: true, cowork: true,
            evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() },
        })),
        stop: async () => ({ processExited: true, profileReleased: true }),
    });
    let persistence;
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 30 },
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    t.after(async () => {
        persistence?.close(); await lifecycle.close(); await release();
        await rm(dataDir, { recursive: true, force: true });
    });
    const owner = "example-native-retire-owner";
    for (const action of ["wire-sign-in", ...(connect ? ["microsoft-connect"] : [])]) {
        const result = await lifecycle.command(owner, { action, operationId: randomUUID(),
            generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
        assert.equal(result.outcome, "completed");
    }
    persistence = await createNativePersistence(context, { lifecycle, transport });
    const admission = { owner, check() {}, dispatched() {} };
    if (!connect) return { context, persistence, lifecycle, transport, admission, owner };
    await persistence.configure({ expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 }, admission);
    const operationId = randomUUID();
    const begun = await persistence.begin({ operationId }, admission);
    assert.equal(begun.kind, "acquire");
    const stateHash = async () => createHash("sha256").update(await readFile(path.join(dataDir, `${BOARD_ID}.state.json`))).digest("hex");
    const files = async () => {
        try { return await readdir(path.join(dataDir, "private-evidence")); }
        catch (error) { if (error.code !== "ENOENT") throw error; return []; }
    };
    const before = { hash: await stateHash(), files: await files() };
    return { context, dataDir, persistence, lifecycle, transport, admission, owner, operationId, begun, stateHash, files, before };
}

test("retiring a registered native attempt irrevocably denies its late commit without retained writes", async t => {
    const { persistence, lifecycle, admission, owner, operationId, begun, stateHash, files, before } = await setup(t);
    persistence.retire(begun.ticket);
    persistence.retire(begun.ticket);
    await lifecycle.assertLease(begun.ticket.lease);
    await assert.rejects(persistence.commit(begun.ticket, []), { code: "NATIVE_RETENTION_TICKET_RETIRED" });
    assert.equal(await stateHash(), before.hash);
    assert.deepEqual(await files(), before.files);
    const status = await persistence.status({ operationId }, { owner });
    assert.equal(status.receipt.status, "unknown");
    const again = await persistence.begin({ operationId }, admission);
    assert.equal(again.kind, "unresolved");
    assert.equal(again.receipt.status, "unknown");
});

test("configure and a racing Pause converge on committed window settings without resetting either field", async t => {
    const { context, persistence, lifecycle, admission, owner, begun } = await setup(t);
    persistence.retire(begun.ticket);
    const before = await readNativeCollectionSettings(context);
    await persistence.configure({ expectedRevision: before.configurationRevision, surfaces: ["chat", "cowork"], windowDays: 7 }, admission);
    assert.equal((await readNativeCollectionSettings(context)).windowDays, 7);
    assert.equal((await lifecycle.collectionIntent()).windowDays, 30);
    await lifecycle.setNativeCollectionEnabled(false, (await lifecycle.status()).authorizationRevision, admission);
    const paused = await readNativeCollectionSettings(context);
    assert.equal(paused.paused, true);
    assert.equal(paused.windowDays, 7);
    await lifecycle.updateCollection(async () => {
        const current = await readNativeCollectionSettings(context);
        return { paused: current.paused, windowDays: current.windowDays };
    });
    assert.equal((await lifecycle.status()).collection, "paused");
    await assert.rejects(lifecycle.lease("microsoft-read"));
    await lifecycle.setNativeCollectionEnabled(true, (await lifecycle.status()).authorizationRevision, admission);
    assert.equal((await lifecycle.collectionIntent()).windowDays, 7);
    const status = await persistence.status({}, { owner });
    assert.equal(status.configuration.settings.windowDays, 7);
    assert.equal(status.configuration.settings.paused, false);
});

test("retired committed tickets can recover only the authorized original receipt without another write", async t => {
    const { persistence, admission, owner, operationId, begun, stateHash, files } = await setup(t);
    const receipt = await persistence.commit(begun.ticket, []);
    persistence.retire(begun.ticket);
    const committed = { hash: await stateHash(), files: await files() };
    assert.deepEqual(await persistence.commit(begun.ticket, []), receipt);
    assert.deepEqual(await persistence.begin({ operationId }, admission), { kind: "committed", receipt });
    assert.deepEqual((await persistence.status({ operationId }, { owner })).receipt, receipt);
    await assert.rejects(persistence.status({ operationId }, { owner: "different-example-native-owner" }),
        { code: "NATIVE_RETENTION_OPERATION_OWNER" });
    assert.equal(await stateHash(), committed.hash);
    assert.deepEqual(await files(), committed.files);
});

test("a commit queued before retirement rechecks its ticket at the actual store boundary", async t => {
    const { dataDir, persistence, begun, stateHash, files, before } = await setup(t);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const originalRead = filesystem.readFile;
    let reads = 0;
    const mock = t.mock.method(filesystem, "readFile", async (file, ...args) => {
        if (path.resolve(String(file)) === path.join(dataDir, `${BOARD_ID}.state.json`) && ++reads === 2) {
            entered.resolve();
            await resume.promise;
        }
        return originalRead(file, ...args);
    });

    syncBuiltinESMExports();
    t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
    const pending = assert.rejects(persistence.commit(begun.ticket, []), { code: "NATIVE_RETENTION_TICKET_RETIRED" });
    await entered.promise;
    persistence.retire(begun.ticket);
    resume.resolve();
    await pending;
    mock.mock.restore(); syncBuiltinESMExports();
    assert.equal(await stateHash(), before.hash);
    assert.deepEqual(await files(), before.files);
});

for (const lockRead of [3, 4]) {
    test(`retirement during writer-lock check ${lockRead} fences the next retained mutation`, async t => {
        const { dataDir, persistence, admission, owner, operationId, begun, stateHash, files, before } = await setup(t);
        const entered = Promise.withResolvers(), resume = Promise.withResolvers();
        const originalRead = filesystem.readFile;
        let reads = 0, dispatched = false;
        admission.dispatched = () => { dispatched = true; };
        const mock = t.mock.method(filesystem, "readFile", async (file, ...args) => {
            if (path.resolve(String(file)) === path.join(dataDir, "collector.lock") && ++reads === lockRead) {
                entered.resolve();
                await resume.promise;
            }
            return originalRead(file, ...args);
        });
        syncBuiltinESMExports();
        t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
        const pending = assert.rejects(persistence.commit(begun.ticket, []), { code: "NATIVE_RETENTION_TICKET_RETIRED" });
        await entered.promise;
        persistence.retire(begun.ticket);
        resume.resolve();
        await pending;
        mock.mock.restore(); syncBuiltinESMExports();
        assert.equal(await stateHash(), before.hash);
        assert.equal(dispatched, lockRead === 4);
        if (lockRead === 3) assert.deepEqual(await files(), before.files);
        else assert.equal((await files()).length, before.files.length + 1, "Already dispatched staging may leave an uncommitted blob.");
        assert.equal((await persistence.status({ operationId }, { owner })).receipt.status, "unknown");
    });
}

test("normal deletion removes committed native variants and tombstones suppress their later captures", async t => {
    const { context, persistence, lifecycle, admission, owner, begun } = await setup(t);
    const source = [coworkFixture().find(item => item.record.event === "ts")];
    const state = await loadBoardState(context, { readOnly: true });
    const account = state.nativeRetention.accounts.find(item => item.partition === begun.ticket.lease.partition);
    source[0].scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
    await persistence.commit(begun.ticket, source);
    persistence.retire(begun.ticket);
    const changed = await persistence.begin({ operationId: randomUUID() }, admission);
    source[0].capture.captureId += "-changed";
    source[0].qualifiedFields.input.value = { query: "changed non-secret input" };
    source[0].record.data.inp = JSON.stringify(source[0].qualifiedFields.input.value);
    const receipt = await persistence.commit(changed.ticket, source);
    persistence.retire(changed.ticket);
    assert.equal(receipt.status, "committed");
    assert.equal((await persistence.readAuthorized(await lifecycle.lease("microsoft-retained"))).records.length, 2);
    const deletion = createDeletionController(context);
    const local = await persistence.localActivityDeletionAdmission(admission);
    const preview = await deletion.preview(owner, { scope: "all" }, local);
    assert.equal(preview.counts.records, 1);
    const removed = await deletion.confirm(owner, { operationId: preview.operationId, confirmed: true }, local);
    assert.equal(removed.phase, "complete");
    const deleted = await loadBoardState(context, { readOnly: true });
    assert.notEqual(deleted.nativeRetention.partitions[0].file, receipt.snapshot + ".json");
    const empty = await persistence.readAuthorized(await lifecycle.lease("microsoft-retained"));
    assert.equal(empty.records.length, 0);
    assert.equal(empty.readback.committed, null);
    const next = await persistence.begin({ operationId: randomUUID() }, admission);
    source[0].capture.captureId += "-later";
    const recaptured = await persistence.commit(next.ticket, source);
    assert.equal(recaptured.changes.addedObservations, 0);
    assert.equal(recaptured.changes.suppressedObservations, 1);
    assert.equal((await persistence.readAuthorized(await lifecycle.lease("microsoft-retained"))).records.length, 0);
});

async function committedReportFixture(t, options) {
    const app = await setup(t, options);
    const state = await loadBoardState(app.context, { readOnly: true });
    const account = state.nativeRetention.accounts.find(item => item.partition === app.begun.ticket.lease.partition);
    const rows = coworkFixture();
    for (const row of rows) row.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
    const receipt = await app.persistence.commit(app.begun.ticket, rows);
    app.persistence.retire(app.begun.ticket);
    const records = projectRetainedNativeRecords(await app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained"))).records;
    const capture = async (request = app.admission) => app.persistence.reportSource.capture({
        revision: (await loadBoardState(app.context, { readOnly: true })).revision,
        scenarioIds: records.map(record => record.scenarioId),
    }, request);
    return { ...app, receipt, records, capture, reports: app.persistence.reportSource };
}

test("a namespaced principal alone cannot reconnect a populated legacy partition by raw account equality", async t => {
    let namespaced = false;
    const app = await committedReportFixture(t, { verifyAccount: async operation => {
        assert.equal(Object.hasOwn(operation, "expectedPartition"), false);
        assert.ok(Number.isSafeInteger(operation.generation));
        return {
            tenantId: "example-tenant", subjectId: "example-subject", knownAccountMatched: true,
            evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString(),
                ...(namespaced ? { namespace: "m365.accountInfo.objectId", realm: "prod" } : {}) },
        };
    } });
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const before = await app.stateHash(), saved = await loadBoardState(app.context), pointer = saved.nativeRetention.partitions[0];
    const bytes = await readFile(path.join(app.dataDir, "private-evidence", pointer.file));
    namespaced = true;
    const result = await app.lifecycle.command(app.owner, { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, replace: false }, () => true);
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "wrong-account");
    assert.equal((await app.lifecycle.status()).microsoft.partition, pointer.partition);
    assert.equal(await app.stateHash(), before);
    assert.deepEqual(await readFile(path.join(app.dataDir, "private-evidence", pointer.file)), bytes);
    assert.equal((await readNativeCollectionSettings(app.context)).paused, true);
});

test("fresh original native-routing evidence preserves a legacy descriptor without replacement or record rewrites", async t => {
    const gateway = "https://example.gateway.prod.island.powerapps.com", currentOrigin = "https://m365.cloud.microsoft";
    let namespaced = false, alter = () => {};
    const app = await committedReportFixture(t, { verifyAccount: async operation => {
        assert.equal(Object.hasOwn(operation, "expectedPartition"), false, "Stored partition never enters the producer.");
        const observedAt = new Date().toISOString();
        const principal = { tenantId: "example-tenant", subjectId: "example-subject", knownAccountMatched: true,
            evidence: { kind: "native-account-metadata", issuer: namespaced ? currentOrigin : gateway, observedAt } };
        if (!namespaced) return principal;
        const common = { captureId: operation.ownerId, frameId: "owned-frame", method: "GET", responseStatus: 200, observedAt };
        Object.assign(principal.evidence, { namespace: "m365.accountInfo.objectId", realm: "prod",
            nativeRouting: { schemaVersion: 1, sourceContract: "m365-accountInfo-cowork-headers-v1",
                ownerId: operation.ownerId, generation: operation.generation, observedAt, issuer: gateway,
                tenantId: principal.tenantId, subjectId: principal.subjectId, namespace: "m365.accountInfo.objectId", realm: "prod",
                current: { ...common, captureId: "principal-capture", requestId: "principal-request", networkId: "principal-network",
                    requestOrigin: currentOrigin, requestPath: "/_serverFn/" + "a".repeat(64) },
                routing: { ...common, captureId: "routing-capture", requestId: "routing-request", networkId: "routing-network",
                    requestOrigin: gateway, responseOrigin: gateway, endpointOrigin: gateway },
                routed: { ...common, captureId: "list-capture", requestId: "list-request", networkId: "list-network",
                    requestOrigin: gateway, responseOrigin: gateway, requestPath: "/v1/tasks/live" },
            } });
        alter(principal);
        return principal;
    } });
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const before = await app.stateHash(), saved = await loadBoardState(app.context), pointer = saved.nativeRetention.partitions[0];
    const bytes = await readFile(path.join(app.dataDir, "private-evidence", pointer.file));
    namespaced = true;
    const connect = async () => app.lifecycle.command(app.owner, { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, replace: false }, () => true);
    for (const change of [
        proof => { delete proof.evidence.nativeRouting; },
        proof => { proof.evidence.nativeRouting.generation--; },
        proof => { proof.evidence.nativeRouting.ownerId = "different-owner"; },
        proof => { proof.evidence.nativeRouting.observedAt = new Date(Date.now() - 600000).toISOString(); },
        proof => { proof.evidence.nativeRouting.tenantId = "different-tenant"; },
        proof => { proof.evidence.nativeRouting.subjectId = "different-subject"; },
        proof => { proof.evidence.nativeRouting.namespace = "another-namespace"; },
        proof => {
            const other = "https://other.gateway.prod.island.powerapps.com", mapping = proof.evidence.nativeRouting;
            mapping.issuer = other; mapping.routing.endpointOrigin = other;
            mapping.routed.requestOrigin = other; mapping.routed.responseOrigin = other;
        },
        proof => { proof.evidence.nativeRouting.routed.responseOrigin = "https://other.gateway.prod.island.powerapps.com"; },
        proof => { Object.assign(proof.evidence.nativeRouting.current, { method: "POST", requestPath: "/chat" }); },
        proof => { Object.assign(proof.evidence.nativeRouting.current, { method: "POST", requestPath: "/landingv2?unqualified=1" }); },
        proof => { Object.assign(proof.evidence.nativeRouting.current, { method: "PUT", requestPath: "/landingv2" }); },
        proof => { Object.assign(proof.evidence.nativeRouting.current, { method: "POST", requestPath: "/landingv2", responseStatus: 302 }); },
        proof => { proof.evidence.nativeRouting.current.requestPath = "/chat/unqualified"; },
        proof => { proof.evidence.nativeRouting.current.requestOrigin = "https://unqualified.invalid"; },
    ]) {
        alter = change;
        assert.equal((await connect()).outcome, "failed");
        assert.equal((await app.lifecycle.status()).microsoft.partition, pointer.partition);
        assert.equal(await app.stateHash(), before);
    }
    alter = () => {};
    const connected = await connect();
    assert.equal(connected.outcome, "completed");
    for (const requestPath of ["/chat", "/hwav2/chat", "/", "/home", "/landingv2"]) {
        alter = proof => {
            const responseOrigin = requestPath === "/home" ? "https://copilot.cloud.microsoft" : currentOrigin;
            proof.evidence.issuer = responseOrigin;
            Object.assign(proof.evidence.nativeRouting.current, { method: "GET", requestPath, requestOrigin: responseOrigin });
        };
        assert.equal((await connect()).outcome, "completed");
        assert.equal(await app.stateHash(), before);
    }
    alter = proof => {
        proof.evidence.issuer = "https://copilot.cloud.microsoft";
        Object.assign(proof.evidence.nativeRouting.current, {
            method: "POST", requestPath: "/landingv2", requestOrigin: proof.evidence.issuer,
        });
    };
    assert.equal((await connect()).outcome, "completed");
    assert.equal((await app.lifecycle.status()).microsoft.partition, pointer.partition);
    const identity = app.transport.accountFor(await app.lifecycle.lease("microsoft-retained"));
    assert.equal(identity.partition, pointer.partition);
    assert.equal(identity.issuer, gateway);
    assert.equal(identity.namespace, "m365.accountInfo.objectId");
    assert.equal(Object.hasOwn(identity, "nativeRouting"), false, "Transient routing witness is not account or store metadata.");
    assert.equal(await app.stateHash(), before);
    assert.deepEqual(await readFile(path.join(app.dataDir, "private-evidence", pointer.file)), bytes);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, saved.nativeRetention);
    assert.deepEqual((await app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained"))).records,
        validateNativeRetainedDocument(JSON.parse(bytes)).records);
    await assert.rejects(app.lifecycle.lease("microsoft-read"), { code: "lease-invalid" });
});

test("report source requires committed disk evidence and process-owned owner-bound frames", async t => {
    const uncommitted = await setup(t);
    await assert.rejects(uncommitted.persistence.reportSource.capture({ revision: (await loadBoardState(uncommitted.context)).revision,
        scenarioIds: ["not-a-committed-conversation"] }, uncommitted.admission), { code: "NATIVE_REPORT_COMMITTED_SOURCE_REQUIRED" });
    const app = await committedReportFixture(t), frame = await app.capture();
    assert.equal(isNativeReportSource(app.reports, app.context), true);
    assert.equal(isNativeReportSource({ ...app.reports }, app.context), false);
    assert.equal(isNativeReportSource(app.reports, {}), false);
    assert.equal(Object.isFrozen(frame.records[0].nativeConversation.observations), true);
    assert.deepEqual(frame.records, app.records);
    const source = JSON.stringify(frame.source);
    assert.equal(source.includes(app.receipt.partition), false);
    assert.equal(source.includes(app.receipt.snapshot), false);
    assert.match(frame.source.sourceSnapshotRef, /^[a-f0-9]{64}$/);
    assert.notEqual(frame.source.sourceSnapshotRef, frame.source.sourceRevisionRef);
    assert.deepEqual((await app.capture()).source, frame.source);
    const before = await app.stateHash();
    await app.reports.validate(frame, app.admission);
    assert.equal(await app.stateHash(), before);
    await assert.rejects(app.reports.validate(structuredClone(frame), app.admission), { code: "NATIVE_REPORT_FRAME_INVALID" });
    await assert.rejects(app.reports.validate(frame, { ...app.admission, owner: "different-example-native-owner" }), { code: "NATIVE_REPORT_FRAME_INVALID" });
    await assert.rejects(app.reports.validate(frame, app.admission, async () => true), { code: "NATIVE_REPORT_PUBLICATION_MUST_BE_SYNCHRONOUS" });
});

test("rejected asynchronous report admissions fail closed without an unhandled rejection", async t => {
    const app = await committedReportFixture(t), frame = await app.capture(), before = await app.stateHash();
    await assert.rejects(app.reports.validate(frame, { ...app.admission,
        async check() { throw new Error("Rejected test admission."); } }),
    { code: "NATIVE_RETENTION_REQUEST_REVOKED" });
    await new Promise(resolve => setImmediate(resolve));
    let entered = false;
    await assert.rejects(app.reports.commit(frame, { ...app.admission,
        async dispatched() { throw new Error("Rejected test dispatch."); } }, () => { entered = true; }),
    { code: "NATIVE_RETENTION_REQUEST_INVALID" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, false);
    assert.equal(await app.stateHash(), before);
});

test("mixed report publication checks GitHub dependencies against the private locked current state", async t => {
    const app = await committedReportFixture(t), frame = await app.capture();
    const original = await loadBoardState(app.context);
    await replaceEvidence(app.context, () => ({ records: [{ scenarioId: "mixed-github-context", title: "Current fixture" }] }));
    const latest = await loadBoardState(app.context), before = await app.stateHash();
    assert.notEqual(latest.evidenceRevision, original.evidenceRevision);
    await assert.rejects(app.reports.validate(frame, app.admission, state => {
        assert.equal(state.revision, latest.revision);
        assert.equal(Object.hasOwn(state, "evidence"), true);
        assert.equal(state.evidence[0].scenarioId, "mixed-github-context");
        if (state.evidenceRevision !== original.evidenceRevision) throw new Error("Mixed source dependency changed.");
    }), /Mixed source dependency changed/);
    const result = await app.reports.validate(frame, app.admission, state => {
        assert.equal(state.evidenceRevision, latest.evidenceRevision);
        return "published-with-current-dependencies";
    });
    assert.equal(result, "published-with-current-dependencies");
    assert.equal(await app.stateHash(), before);
});

test("fresh report capture permits Pause and provider expiry without requiring an operation receipt", async t => {
    const app = await committedReportFixture(t), original = await app.capture();
    const acquisition = await app.lifecycle.lease("microsoft-read");
    await app.lifecycle.expire(acquisition);
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    await assert.rejects(app.lifecycle.lease("microsoft-read"));
    await assert.rejects(app.reports.validate(original, app.admission));
    await updateBoardState(app.context, state => { state.nativeRetention.receipts = []; });
    const retained = await app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained"));
    assert.equal(retained.readback.committed, null);
    const fresh = await app.capture();
    assert.equal(fresh.records.length, app.records.length);
    assert.equal(fresh.source.sourceSnapshotRef, original.source.sourceSnapshotRef);
    assert.notEqual(fresh.source.sourceRevisionRef, original.source.sourceRevisionRef);
    await app.reports.validate(fresh, app.admission);
});

test("report commit owns one board save, privately binds the account and cannot replay its frame", async t => {
    const app = await committedReportFixture(t), frame = await app.capture();
    const before = await loadBoardState(app.context, { readOnly: true });
    let assertion;
    const saved = await app.reports.commit(frame, app.admission, async (state, assertCurrent) => {
        assertion = assertCurrent;
        assertCurrent();
        await Promise.resolve();
        assertCurrent();
        const entry = { bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) };
        state.exports.push(entry);
        return entry;
    });
    assert.equal(saved.state.revision, before.revision + 1);
    const latest = await loadBoardState(app.context, { readOnly: true });
    assert.equal(latest.exports.at(-1).bundleId, saved.result.bundleId);
    assert.equal(Object.hasOwn(saved.result, "nativeSourceBinding"), false);
    assert.deepEqual(Object.keys(latest.exports.at(-1).nativeSourceBinding).sort(), ["account", "schemaVersion"]);
    assert.match(latest.exports.at(-1).nativeSourceBinding.account, /^[a-f0-9]{64}$/);
    assert.notEqual(latest.exports.at(-1).nativeSourceBinding.account, app.receipt.partition);
    assert.equal(before.stateVersion, 4);
    assert.equal(latest.stateVersion, 5);
    assert.equal(latest.nativeReportPolicy, "native-report-account-bound-v1");
    assert.throws(() => validateNativeReportState({ ...latest, stateVersion: 4 }), { code: "NATIVE_REPORT_STATE_INVALID" });
    assert.throws(() => validateNativeReportState({ ...latest, nativeReportPolicy: undefined }), { code: "NATIVE_REPORT_STATE_INVALID" });
    assert.throws(assertion, { code: "NATIVE_REPORT_ADMISSION_EXPIRED" });
    await assert.rejects(app.reports.commit(frame, app.admission, () => {}), { code: "NATIVE_REPORT_FRAME_CONSUMED" });
    await updateBoardState(app.context, state => { state.exports = []; });
    await app.persistence.configure({ expectedRevision: latest.nativeRetention.configurationRevision,
        surfaces: ["chat", "cowork"], windowDays: 7 }, app.admission);
    assert.equal((await loadBoardState(app.context)).stateVersion, 5, "Native collection cannot downgrade the report policy after history removal.");
    for (const enabled of [false, true]) {
        await app.lifecycle.setNativeCollectionEnabled(enabled, (await app.lifecycle.status()).authorizationRevision, app.admission);
        assert.equal((await loadBoardState(app.context)).stateVersion, 5);
    }
    const intentStore = await createNativePersistence(app.context, { lifecycle: app.lifecycle, transport: app.transport, configurationIntents: true });
    try {
        const offer = await intentStore.configurationOffer(app.admission);
        const input = { schemaVersion: 1, intent: offer.intent, generation: offer.generation,
            authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision,
            surfaces: offer.values.surfaces, windowDays: 14 };
        await app.lifecycle.admitNativeConfiguration({ intent: input.intent, windowDays: input.windowDays }, app.admission,
            (token, guarded) => intentStore.configureIntent(input, token, guarded));
        assert.equal((await loadBoardState(app.context)).stateVersion, 5);
    } finally { intentStore.close(); }
    const next = await app.persistence.begin({ operationId: randomUUID() }, app.admission);
    assert.equal((await loadBoardState(app.context)).stateVersion, 5);
    await app.persistence.commit(next.ticket, []);
    app.persistence.retire(next.ticket);
    assert.equal((await loadBoardState(app.context)).stateVersion, 5);
    await replaceEvidence(app.context, () => ({ records: [] }));
    assert.equal((await loadBoardState(app.context)).stateVersion, 5);
    const deletion = createDeletionController(app.context);
    const local = await app.persistence.localActivityDeletionAdmission(app.admission);
    const preview = await deletion.preview(app.owner, { scope: "all" }, local);
    await deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }, local);
    const deleted = await loadBoardState(app.context);
    assert.equal(deleted.stateVersion, 5);
    assert.equal(deleted.nativeReportPolicy, "native-report-account-bound-v1");
});

test("report source invalidates changed configuration, deletion and signout instead of substituting new data", async t => {
    const app = await committedReportFixture(t), frame = await app.capture();
    const config = await readNativeCollectionSettings(app.context);
    await app.persistence.configure({ expectedRevision: config.configurationRevision, surfaces: ["chat", "cowork"], windowDays: 7 }, app.admission);
    await assert.rejects(app.reports.validate(frame, app.admission), { code: "NATIVE_REPORT_SOURCE_STALE" });
    const refreshed = await app.capture();
    const deletion = createDeletionController(app.context);
    const local = await app.persistence.localActivityDeletionAdmission(app.admission);
    const preview = await deletion.preview(app.owner, { scope: "all" }, local);
    await deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }, local);
    await assert.rejects(app.reports.validate(refreshed, app.admission), { code: "NATIVE_REPORT_SOURCE_STALE" });
    await assert.rejects(app.capture(), { code: "NATIVE_REPORT_SELECTION_CHANGED" });
    await app.lifecycle.command(app.owner, { action: "wire-sign-out", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation }, () => true);
    await assert.rejects(app.reports.validate(refreshed, app.admission));
});

test("report request revocation at the final asynchronous lock gap prevents the index save and replay", async t => {
    const app = await committedReportFixture(t);
    let revoked = false, dispatched = 0;
    const request = { owner: app.owner, check() { return !revoked; }, dispatched() { dispatched++; } };
    const frame = await app.capture(request), before = await app.stateHash();
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), original = filesystem.realpath;
    let locks = 0;
    const mock = t.mock.method(filesystem, "realpath", async (...args) => {
        const result = await original(...args);
        if (++locks === 3) { entered.resolve(); await resume.promise; }
        return result;
    });

    syncBuiltinESMExports();
    t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
    const pending = assert.rejects(app.reports.commit(frame, request, async state => {
        state.exports.push({ bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) });
    }), { code: "NATIVE_RETENTION_REQUEST_REVOKED" });
    await entered.promise;
    revoked = true; resume.resolve();
    await pending;
    assert.equal(dispatched, 1);
    assert.equal(await app.stateHash(), before);
    revoked = false;
    await assert.rejects(app.reports.commit(frame, request, () => {}), { code: "NATIVE_REPORT_FRAME_CONSUMED" });
});

test("saved report reads hide foreign accounts, strip private bindings and reject exact unauthorized IDs", async t => {
    const app = await committedReportFixture(t), frame = await app.capture();
    const nativeId = `export-${randomUUID()}`, legacyId = `export-${randomUUID()}`, foreignId = `export-${randomUUID()}`;
    await app.reports.commit(frame, app.admission, state => { state.exports.push({ bundleId: nativeId, kind: "report", nativeEvidenceHash: "a".repeat(64) }); });
    await updateBoardState(app.context, state => {
        state.exports.push({ bundleId: legacyId, kind: "report" },
            { bundleId: foreignId, kind: "report", nativeEvidenceHash: "a".repeat(64), nativeSourceBinding: { schemaVersion: 1, account: "0".repeat(64) } });
    });
    const visible = await app.reports.readSaved({ bundleIds: null }, app.admission, async (state, entries, assertCurrent) => {
        assertCurrent(); await Promise.resolve(); assertCurrent();
        assert.deepEqual(state.exports, entries);
        return entries;
    });
    assert.deepEqual(visible.map(entry => entry.bundleId), [nativeId, legacyId]);
    assert.equal(JSON.stringify(visible).includes("nativeSourceBinding"), false);
    await assert.rejects(app.reports.readSaved({ bundleIds: [foreignId] }, app.admission, () => {}),
        { code: "NATIVE_REPORT_ACCOUNT_REQUIRED" });
    const selected = await app.reports.readSaved({ bundleIds: [nativeId] }, app.admission, (_state, entries) => entries);
    assert.deepEqual(selected, [visible[0]]);
    let revoked = false;
    await assert.rejects(app.reports.readSaved({ bundleIds: [nativeId] },
        { ...app.admission, check: () => !revoked }, async () => { revoked = true; return visible; }),
    { code: "NATIVE_RETENTION_REQUEST_REVOKED" });
    await app.lifecycle.command(app.owner, { action: "wire-sign-out", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation }, () => true);
    await assert.rejects(app.reports.readSaved({ bundleIds: null }, app.admission, () => visible));
});

test("legacy saved-report reads work without Microsoft account or committed native source", async t => {
    const app = await setup(t, { connect: false }), bundleId = `export-${randomUUID()}`;
    await updateBoardState(app.context, state => { state.exports.push({ bundleId, kind: "report" }); });
    const visible = await app.persistence.reportSource.readSaved({ bundleIds: null }, app.admission, (_state, entries) => entries);
    assert.deepEqual(visible, [{ bundleId, kind: "report" }]);
    assert.equal((await loadBoardState(app.context)).stateVersion, 2);
});

test("saved report callbacks can check the actual private corpus basis without weakening stripped reader state", async t => {
    const app = await committedReportFixture(t), bundleId = `export-${randomUUID()}`;
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId, kind: "report", nativeEvidenceHash: "a".repeat(64) });
    });
    await replaceEvidence(app.context, () => ({ records: [{ scenarioId: "saved-github-context", title: "Current fixture" }] }));
    const before = await app.stateHash();
    let expired;
    const visible = await app.reports.readSaved({ bundleIds: [bundleId] }, app.admission,
        async (selected, entries, assertCurrent, actual) => {
            expired = assertCurrent;
            assertCurrent();
            assert.notEqual(selected, actual);
            assert.equal(Object.hasOwn(selected, "evidence"), false);
            assert.equal(Object.hasOwn(actual, "evidence"), true);
            assert.equal(actual.evidence[0].scenarioId, "saved-github-context");
            assert.equal(Object.hasOwn(actual.exports[0], "nativeSourceBinding"), true);
            assert.equal(Object.hasOwn(entries[0], "nativeSourceBinding"), false);
            assert.deepEqual(selected.exports, entries);
            await Promise.resolve();
            assertCurrent();
            return entries.map(entry => entry.bundleId);
        });
    assert.deepEqual(visible, [bundleId]);
    assert.equal(await app.stateHash(), before);
    assert.throws(expired, { code: "NATIVE_REPORT_ADMISSION_EXPIRED" });
});

test("report validation and pre-dispatch commit recheck the exact committed disk bytes", async t => {
    const app = await committedReportFixture(t), frame = await app.capture();
    const file = path.join(app.dataDir, "private-evidence", app.receipt.snapshot + ".json"), original = await readFile(file);
    try {
        await filesystem.writeFile(file, "{}");
        await assert.rejects(app.reports.validate(frame, app.admission), { code: "NATIVE_RETENTION_INTEGRITY" });
        let dispatched = false;
        await assert.rejects(app.reports.commit(frame, { ...app.admission, dispatched() { dispatched = true; } }, () => {}),
            { code: "NATIVE_RETENTION_INTEGRITY" });
        assert.equal(dispatched, false);
    } finally { await filesystem.writeFile(file, original); }
});

test("a fresh paused persistence instance restores native artifact account authorization without provider access", async t => {
    const app = await committedReportFixture(t), frame = await app.capture(), bundleId = `export-${randomUUID()}`;
    await app.reports.commit(frame, app.admission, state => { state.exports.push({ bundleId, kind: "report", nativeEvidenceHash: "a".repeat(64) }); });
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const saved = await loadBoardState(app.context, { readOnly: true });
    app.persistence.close();
    await app.lifecycle.close();
    const settings = await readNativeCollectionSettings(app.context);
    assert.equal(settings.paused, true);
    let providerCalls = 0;
    const transport = createMicrosoftNativeReadTransport({
        async open() { providerCalls++; throw new Error("Provider access is forbidden in retained restart."); },
        async verifyAccount() { providerCalls++; throw new Error("Provider access is forbidden in retained restart."); },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    let persistence;
    const lifecycle = await createMicrosoftSession(app.context, { transport,
        collection: { paused: settings.paused, windowDays: settings.windowDays },
        persistCollectionSettings: (value, token) => persistence.persistCollectionSettings(value, token) });
    try {
        persistence = await createNativePersistence(app.context, { lifecycle, transport });
        const restored = await persistence.reportSource.readSaved({ bundleIds: [bundleId] }, app.admission, (_state, entries) => entries);
        assert.deepEqual(restored, [{ bundleId, kind: "report", nativeEvidenceHash: "a".repeat(64) }]);
        assert.equal(providerCalls, 0);
        assert.equal((await loadBoardState(app.context, { readOnly: true })).stateVersion, 5);
        assert.deepEqual((await loadBoardState(app.context, { readOnly: true })).exports, saved.exports);
        await assert.rejects(app.reports.validate(frame, app.admission), { code: "NATIVE_RETENTION_CLOSED" });
    } finally { persistence?.close(); await lifecycle.close(); }
});

test("native report identity, private binding and state5 policy cannot be separated or relabeled legacy", async t => {
    const app = await committedReportFixture(t);
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) });
    });
    const state = await loadBoardState(app.context);
    for (const change of [
        value => { delete value.exports[0].nativeSourceBinding; },
        value => { delete value.exports[0].nativeEvidenceHash; },
        value => { value.exports[0].nativeEvidenceHash = "invalid"; },
        value => { value.exports[0].evaluationFactsHash = "b".repeat(64); },
        value => { value.exports[0].evaluationFactsHash = undefined; },
        value => { value.stateVersion = 4; delete value.nativeReportPolicy; delete value.exports[0].nativeSourceBinding; },
    ]) {
        const changed = structuredClone(state);
        change(changed);
        assert.throws(() => validateNativeReportState(changed), { code: "NATIVE_REPORT_STATE_INVALID" });
    }
    const before = await app.stateHash();
    await assert.rejects(updateBoardState(app.context, value => { delete value.exports[0].nativeSourceBinding; }),
        { code: "NATIVE_REPORT_STATE_INVALID" });
    assert.equal(await app.stateHash(), before);
});

test("native report commit requires its public hash and keeps comparison writes closed", async t => {
    const app = await committedReportFixture(t), before = await app.stateHash();
    for (const entry of [
        { kind: "report" },
        { kind: "report", nativeEvidenceHash: "a".repeat(64), evaluationFactsHash: "b".repeat(64) },
        { kind: "comparison", nativeEvidenceHash: "a".repeat(64) },
    ]) {
        const frame = await app.capture();
        await assert.rejects(app.reports.commit(frame, app.admission, state => {
            state.exports.push({ bundleId: `export-${randomUUID()}`, ...entry });
        }), { code: entry.kind === "comparison" ? "NATIVE_REPORT_HISTORY_INVALID" : "NATIVE_REPORT_STATE_INVALID" });
        assert.equal(await app.stateHash(), before);
    }
});

test("state5 runtime qualification rejects missing, copied, foreign and closed report sources without granting read access", async t => {
    const app = await committedReportFixture(t);
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) });
    });
    const state = await loadBoardState(app.context);
    for (const source of [undefined, {}, { ...app.reports }]) {
        assert.throws(() => assertNativeReportRuntime(state, source, app.context), { code: "NATIVE_REPORT_RUNTIME_REQUIRED" });
    }
    assert.throws(() => assertNativeReportRuntime(state, app.reports, { ...app.context }), { code: "NATIVE_REPORT_RUNTIME_REQUIRED" });
    assertNativeReportRuntime(state, app.reports, app.context);
    await app.lifecycle.command(app.owner, { action: "wire-sign-out", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation }, () => true);
    assertNativeReportRuntime(state, app.reports, app.context);
    await assert.rejects(app.reports.readSaved({ bundleIds: null }, app.admission, () => state.exports));
    assert.throws(() => assertNativeReportRuntime({ ...state, exports: [] }, undefined, app.context), { code: "NATIVE_REPORT_RUNTIME_REQUIRED" });
    app.persistence.close();
    assert.throws(() => assertNativeReportRuntime(state, app.reports, app.context), { code: "NATIVE_REPORT_RUNTIME_REQUIRED" });
    assert.doesNotThrow(() => assertNativeReportRuntime({ stateVersion: 2, exports: [] }, undefined, app.context));
});

test("legacy migration cannot erase native report bindings from a malformed unversioned store", async t => {
    const app = await committedReportFixture(t);
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) });
    });
    const file = path.join(app.dataDir, `${BOARD_ID}.state.json`), state = await loadBoardState(app.context);
    delete state.stateVersion;
    const malformed = JSON.stringify(state);
    await filesystem.writeFile(file, malformed);
    await assert.rejects(loadBoardState(app.context), { code: "NATIVE_REPORT_STATE_INVALID" });
    assert.equal(await readFile(file, "utf8"), malformed);
});

test("board writers cannot remove the sticky report policy after clearing every native index entry", async t => {
    const app = await committedReportFixture(t);
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) });
    });
    const before = await app.stateHash();
    await assert.rejects(updateBoardState(app.context, state => {
        state.exports = [];
        state.stateVersion = 4;
        delete state.nativeReportPolicy;
    }), { code: "NATIVE_REPORT_STATE_INVALID" });
    assert.equal(await app.stateHash(), before);
    await assert.rejects(exclusiveBoard(app.context, async (state, save) => {
        const { nativeReportPolicy, ...unbound } = state;
        await save({ ...unbound, exports: [], stateVersion: 4 });
    }), { code: "NATIVE_REPORT_STATE_INVALID" });
    assert.equal(await app.stateHash(), before);
});
for (const { reports, global } of [
    { reports: false, global: false }, { reports: true, global: false },
    { reports: false, global: true }, { reports: true, global: true },
]) {
    test(`new Collect adoption preserves old receipts, report policy=${reports}, explicit global=${global}`, async t => {
        const app = await committedReportFixture(t);
        if (reports) await app.reports.commit(await app.capture(), app.admission, state => {
            state.exports.push({ bundleId: `export-${randomUUID()}`, kind: "report", nativeEvidenceHash: "a".repeat(64) });
        });
        if (global) {
            const existing = await loadBoardState(app.context, { readOnly: true });
            await filesystem.writeFile(path.join(app.dataDir, `${BOARD_ID}.state.json`),
                JSON.stringify({ ...existing, stateVersion: 6, globalCollection: { revision: 3, paused: false } }));
        }
        const lateLegacy = !reports && !global ? await app.persistence.begin({ operationId: randomUUID() }, app.admission) : null;
        const previous = await loadBoardState(app.context, { readOnly: true });
        const account = previous.nativeRetention.accounts[0], pointer = previous.nativeRetention.partitions[0];
        const oldBytes = await readFile(path.join(app.dataDir, "private-evidence", pointer.file));
        const source = coworkFixture();
        for (const row of source) {
            row.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
            row.capture.captureId += "-fresh";
        }
        const expected = mergeNativeRetainedCapture(JSON.parse(oldBytes), encodeNativeRetainedCapture(account, source));
        const operationId = randomUUID();
        const begun = await app.persistence.beginSegmented({ operationId }, app.admission);
        const registered = await loadBoardState(app.context, { readOnly: true });
        assert.equal(registered.stateVersion, 7);
        assert.equal(Object.hasOwn(registered, "globalCollection"), global);
        assert.deepEqual(registered.globalCollection, previous.globalCollection);
        assert.equal(registered.nativeRetention.partitions[0].file, pointer.file);
        assert.deepEqual(registered.nativeRetention.receipts.slice(0, -1), previous.nativeRetention.receipts);
        const intent = registered.nativeRetention.receipts.at(-1).storageIntent;
        assert.deepEqual(intent, { schemaVersion: 1, kind: "new-capture-with-v1-adoption",
            previousSnapshot: pointer.file.slice(0, -5), previousFormat: "screened-v1", targetFormat: "segments-v2" });
        const pending = (await app.persistence.status({ operationId }, { owner: app.owner })).receipt;
        assert.equal(pending.schemaVersion, 1);
        assert.equal(Object.hasOwn(pending, "storageIntent"), false);
        await assert.rejects(app.persistence.commit(begun.ticket, source), { code: "NATIVE_RETENTION_TICKET_FORMAT" });
        const receipt = await app.persistence.commitSegmented(begun.ticket, source);
        assert.deepEqual(Object.keys(receipt).sort(), Object.keys(app.receipt).sort());
        assert.equal(receipt.schemaVersion, 1);
        assert.equal(receipt.operationId, operationId);
        assert.equal(receipt.changes.addedObservations, 0);
        assert.equal(receipt.changes.addedVariants, 0);
        assert.ok(receipt.changes.addedProvenance > 0);
        const committed = await loadBoardState(app.context, { readOnly: true });
        assert.equal(committed.nativeRetention.partitions[0].file, `${receipt.snapshot}.json`);
        assert.equal(committed.nativeRetention.partitions[0].format, "segments-v2");
        assert.deepEqual(committed.nativeRetention.receipts.slice(0, -1), previous.nativeRetention.receipts);
        assert.deepEqual(committed.exports, previous.exports);
        assert.deepEqual(committed.nativeRetention.settings, previous.nativeRetention.settings);
        assert.equal(committed.nativeReportPolicy, previous.nativeReportPolicy);
        assert.equal(Object.hasOwn(committed, "globalCollection"), global);
        assert.deepEqual(committed.globalCollection, previous.globalCollection);
        assert.deepEqual(await readFile(path.join(app.dataDir, "private-evidence", pointer.file)), oldBytes);
        const reader = await openNativeSegmentedReader({ rootHash: receipt.snapshot, assertCurrent() {},
            readBlock: (hash, bounds) => readPrivateEvidenceBytes(app.context, `${hash}.json`, bounds) });
        try {
            const selection = await reader.select({ sources: ["microsoft-365-cowork"], scenarioIds: null }), entries = [];
            for await (const event of reader.iterate(selection)) if (event.kind === "conversation-part") entries.push(...event.entries);
            assert.deepEqual(entries.toSorted((a, b) => a.inputOrdinal - b.inputOrdinal).map(entry => entry.record),
                validateNativeRetainedDocument(expected.document).records);
        } finally { reader.close(); }
        const sealed = await app.stateHash();
        app.persistence.retire(begun.ticket);
        assert.deepEqual(await app.persistence.commitSegmented(begun.ticket, source), receipt);
        assert.deepEqual(await app.persistence.beginSegmented({ operationId }, app.admission), { kind: "committed", receipt });
        await assert.rejects(app.persistence.status({ operationId }, { owner: "different-example-native-owner" }),
            { code: "NATIVE_RETENTION_OPERATION_OWNER" });
        assert.equal(await app.stateHash(), sealed);
        if (lateLegacy) {
            await assert.rejects(app.persistence.commit(lateLegacy.ticket, source), { code: "NATIVE_SEGMENTED_MERGE_REQUIRED" });
            app.persistence.retire(lateLegacy.ticket);
            assert.equal(await app.stateHash(), sealed);
            const nextSource = structuredClone(source);
            for (const row of nextSource) row.capture.captureId += "-again";
            const nextOperation = randomUUID(), next = await app.persistence.beginSegmented({ operationId: nextOperation }, app.admission);
            const pending = await loadBoardState(app.context, { readOnly: true });
            assert.deepEqual(pending.nativeRetention.receipts.at(-1).storageIntent, {
                schemaVersion: 1, kind: "new-capture", previousSnapshot: receipt.snapshot,
                previousFormat: "segments-v2", targetFormat: "segments-v2",
            });
            const appended = await app.persistence.commitSegmented(next.ticket, nextSource);
            app.persistence.retire(next.ticket);
            assert.equal(appended.changes.addedVariants, 0);
            assert.equal(appended.changes.addedObservations, 0);
            assert.ok(appended.changes.addedProvenance > 0);
            const current = await loadBoardState(app.context, { readOnly: true });
            assert.deepEqual(current.nativeRetention.receipts.slice(0, -1), committed.nativeRetention.receipts);
            assert.deepEqual(await app.persistence.commitSegmented(begun.ticket, source), receipt);
        }
        await assert.rejects(app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained")),
            { code: "NATIVE_SEGMENTED_READER_REQUIRED" });
        await assert.rejects(createDeletionController(app.context).preview(app.owner, { scope: "all" }),
            { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" });
        await replaceEvidence(app.context, () => ({ records: [] }));
        assert.equal((await loadBoardState(app.context, { readOnly: true })).stateVersion, 7);
        await assert.rejects(updateBoardState(app.context, state => {
            delete state.nativeRetention; state.stateVersion = 2;
        }), { code: "NATIVE_RETENTION_STATE_INVALID" });
    });
}

test("segmented retirement after the state temporary file is fsynced still prevents pointer publication", async t => {
    const app = await committedReportFixture(t), operationId = randomUUID();
    const begun = await app.persistence.beginSegmented({ operationId }, app.admission);
    const before = await loadBoardState(app.context, { readOnly: true }), stateHash = await app.stateHash();
    const original = filesystem.open;
    let retired = false;
    const mock = t.mock.method(filesystem, "open", async (file, ...args) => {
        const handle = await original(file, ...args);
        if (path.basename(String(file)).startsWith(".state-") && String(file).endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
                await sync();
                retired = true; app.persistence.retire(begun.ticket);
            };
        }
        return handle;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(app.persistence.commitSegmented(begun.ticket, []), { code: "NATIVE_RETENTION_TICKET_RETIRED" });
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(retired, true);
    assert.equal(await app.stateHash(), stateHash);
    const after = await loadBoardState(app.context, { readOnly: true });
    assert.deepEqual(after.nativeRetention.partitions, before.nativeRetention.partitions);
    assert.deepEqual(after.nativeRetention.receipts, before.nativeRetention.receipts);
    const restored = await app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained"));
    assert.equal(restored.readback.snapshot, app.receipt.snapshot);
    assert.equal(restored.readback.committed.operationId, app.receipt.operationId);
    assert.equal(restored.readback.committed.generation, app.receipt.generation);
    assert.equal((await app.persistence.status({ operationId }, { owner: app.owner })).receipt.status, "unknown");
    assert.equal((await readdir(app.dataDir)).some(file => file.startsWith(".state-") && file.endsWith(".tmp")), false);
});

test("the private global/version matrix rejects invalid policy and blocks new acquisition under explicit Pause", async t => {
    const app = await committedReportFixture(t), original = await loadBoardState(app.context, { readOnly: true });
    for (const [stateVersion, globalCollection] of [
        [4, { revision: 1, paused: true }], [6, null], [6, undefined],
        [6, { revision: 0, paused: true }], [6, { revision: 1, paused: "true" }],
        [6, { revision: 1, paused: true, schemaVersion: 1 }],
    ]) assert.throws(() => validateNativeStorageState({ ...original, stateVersion, globalCollection }),
        { code: "GLOBAL_COLLECTION_STATE_INVALID" });
    assert.throws(() => validateNativeStorageState({ ...original, stateVersion: 6 }), { code: "GLOBAL_COLLECTION_STATE_INVALID" });
    const paused = { ...original, stateVersion: 6, globalCollection: { revision: 2, paused: true } };
    validateNativeStorageState(paused);
    await filesystem.writeFile(path.join(app.dataDir, `${BOARD_ID}.state.json`), JSON.stringify(paused));
    const before = await app.stateHash();
    await assert.rejects(app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission),
        { code: "NATIVE_RETENTION_GLOBAL_PAUSED" });
    assert.equal(await app.stateHash(), before);
    for (const mutate of [
        state => { delete state.globalCollection; },
        state => { state.globalCollection = { revision: 3, paused: false }; },
    ]) {
        await assert.rejects(updateBoardState(app.context, mutate), { code: "GLOBAL_COLLECTION_STATE_INVALID" });
        assert.equal(await app.stateHash(), before);
    }
    const stateFile = path.join(app.dataDir, `${BOARD_ID}.state.json`);
    await filesystem.writeFile(stateFile, JSON.stringify({ ...paused, globalCollection: { revision: 3, paused: false } }));
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const registered = await loadBoardState(app.context, { readOnly: true });
    await filesystem.writeFile(stateFile, JSON.stringify({ ...registered, globalCollection: { revision: 4, paused: true } }));
    const pausedRegistration = await app.stateHash();
    await assert.rejects(app.persistence.commitSegmented(begun.ticket, []), { code: "NATIVE_RETENTION_GLOBAL_PAUSED" });
    assert.equal(await app.stateHash(), pausedRegistration);
    const recovered = await app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained"));
    assert.equal(recovered.readback.snapshot, app.receipt.snapshot);
    assert.equal((await loadBoardState(app.context, { readOnly: true })).stateVersion, 7);
});

for (const segmented of [false, true]) {
    test(`owned ${segmented ? "v2" : "v1"} selection reads preserve root definitions, original views and complete callback admission`, async t => {
        const app = await setup(t), state = await loadBoardState(app.context, { readOnly: true });
        const account = state.nativeRetention.accounts[0];
        function source(suffix = "") {
            const input = nativeCallsSource();
            input.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
            input.capture.captureId += suffix;
            const rows = [...retainNativeChatSourceObservations(decodeNativeChatObservation(input)), ...coworkFixture()];
            for (const row of rows) {
                row.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
                if (row.scope.surface === "cowork") row.capture.captureId += suffix;
            }
            return rows;
        }
        let receipt = await app.persistence.commit(app.begun.ticket, source());
        app.persistence.retire(app.begun.ticket);
        let document = JSON.parse(await readFile(path.join(app.dataDir, "private-evidence", `${receipt.snapshot}.json`)));
        if (segmented) {
            const fresh = source("-selection"), begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
            document = mergeNativeRetainedCapture(document, encodeNativeRetainedCapture(account, fresh)).document;
            receipt = await app.persistence.commitSegmented(begun.ticket, fresh);
            app.persistence.retire(begun.ticket);
        }
        const reference = projectRetainedNativeRecords(validateNativeRetainedDocument(document));
        const chosen = reference.records.filter(record => record.sourceId === "microsoft-365-cowork");
        const current = await loadBoardState(app.context, { readOnly: true });
        const input = { revision: current.revision, sources: ["microsoft-365-cowork"], scenarioIds: chosen.map(record => record.scenarioId) };
        const before = await app.stateHash(), beforeFiles = await app.files();
        let escapedReader, expired;
        const original = await app.persistence.withRetainedReader({ revision: current.revision }, app.admission,
            async (reader, assertCurrent, actual) => {
                escapedReader = reader; expired = assertCurrent;
                assert.equal(reader.storageFormat, segmented ? "segments-v2" : "screened-v1");
                assert.equal(actual.pseudonymKey, current.pseudonymKey);
                const selected = await reader.select({ sources: input.sources, scenarioIds: input.scenarioIds }), entries = [];
                for await (const event of reader.iterate(selected)) if (event.kind === "conversation-part") entries.push(...event.entries);
                assert.ok(entries[0].inputOrdinal > 0);
                assert.deepEqual(await reader.entryAt(entries[0].inputOrdinal), entries[0]);
                const projected = projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries });
                assert.equal(Object.hasOwn(projected.definitions, "sourceObservationPopulation"), false);
                assert.equal(Object.hasOwn(reader.definitions, "sourceObservationPopulation"), true);
                assert.deepEqual(projected.records, chosen);
                assertCurrent();
                return reader.source;
            });
        assert.throws(expired, { code: "NATIVE_REPORT_ADMISSION_EXPIRED" });
        await assert.rejects(escapedReader.select({ sources: input.sources, scenarioIds: input.scenarioIds }), { code: "reader-cancelled" });
        const frame = await app.persistence.reportSource.captureSelection(input, app.admission);
        assert.deepEqual(frame.source, original);
        assert.deepEqual(frame.originalViewExpectations, nativeReportSelectionExpectations(chosen, reference.definitions, current.pseudonymKey));
        assert.equal(JSON.stringify(frame.source).includes(receipt.snapshot), false);
        assert.equal(JSON.stringify(frame.source).includes(account.partition), false);
        const folded = await app.persistence.reportSource.iterateSelection(frame, app.admission, async (events, assertCurrent, actual) => {
            const entries = [];
            for await (const event of events) if (event.kind === "conversation-part") entries.push(...event.entries);
            const projected = projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries });
            assertNativeReportSelection(frame.originalViewExpectations, projected.records, frame.source.definitions, actual.pseudonymKey);
            assertCurrent();
            return projected.records;
        });
        assert.deepEqual(folded, chosen);
        await app.persistence.reportSource.validate(frame, app.admission, actual => {
            assert.equal(actual.pseudonymKey, current.pseudonymKey);
        });
        await assert.rejects(app.persistence.reportSource.iterateSelection({ ...frame }, app.admission, () => {}),
            { code: "NATIVE_REPORT_FRAME_INVALID" });
        await assert.rejects(app.persistence.reportSource.iterateSelection(frame, { ...app.admission, owner: "different-example-native-owner" }, () => {}),
            { code: "NATIVE_REPORT_FRAME_INVALID" });
        await assert.rejects(app.persistence.reportSource.iterateSelection(frame, app.admission, async () => []),
            { code: "NATIVE_REPORT_SELECTION_INCOMPLETE" });
        let revoked = false;
        await assert.rejects(app.persistence.reportSource.iterateSelection(frame, { ...app.admission, check: () => !revoked },
            async events => { await events.next(); revoked = true; return []; }), { code: "NATIVE_RETENTION_REQUEST_REVOKED" });
        await assert.rejects(app.persistence.reportSource.commit(frame, app.admission, () => {}),
            { code: "NATIVE_REPORT_SELECTION_PUBLICATION_NOT_READY" });
        assert.equal(await app.stateHash(), before);
        assert.deepEqual(await app.files(), beforeFiles);
        if (segmented) {
            const root = JSON.parse(await readFile(path.join(app.dataDir, "private-evidence", `${receipt.snapshot}.json`)));
            const file = path.join(app.dataDir, "private-evidence", `${root.tree.hash}.json`), bytes = await readFile(file);
            let published = false;
            try {
                await filesystem.writeFile(file, "{}");
                await assert.rejects(app.persistence.reportSource.validate(frame, app.admission, () => { published = true; }),
                    { code: "EVIDENCE_SNAPSHOT_INTEGRITY" });
                assert.equal(published, false);
            } finally { await filesystem.writeFile(file, bytes); }
        }
    });
}

test("confirmed local Delete all clears signed-out partitions, history, recovery and orphans without source sign-in or report removal", async t => {
    const app = await setup(t, { connect: false }), dir = app.context.dataDir;
    await assert.rejects(app.lifecycle.lease("microsoft-retained"));
    const captures = [], partitions = [], accounts = [];
    const io = { assertCurrent() {}, async writeBlock(value) {
        return (await stagePrivateEvidence(app.context, value.json)).slice(0, -5);
    }, readBlock: (hash, bounds) => readPrivateEvidenceBytes(app.context, `${hash}.json`, bounds) };
    for (const [index, partition] of ["a".repeat(64), "b".repeat(64)].entries()) {
        const source = coworkFixture(), account = { partition, issuer: "https://example.invalid",
            tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId + index };
        for (const row of source) row.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
        const capture = encodeNativeRetainedCapture(account, source), old = mergeNativeRetainedCapture(null, capture).document;
        const legacyFile = await stagePrivateEvidence(app.context, JSON.stringify(old));
        const prepared = await stageNativeV1Capture({ ...io, previous: old, capture });
        captures.push(capture); accounts.push(account);
        partitions.push({ partition, file: `${prepared.candidate.rootHash}.json`, format: "segments-v2", revision: 1, lastOperationId: randomUUID() });
        if (!index) {
            for await (const row of nativeV1SegmentedRows(old, { assertCurrent() {} })) {
                if (row.kind !== "provenance") continue;
                const stranded = encodeNativeSegmentedBlock(nativeSegmentedEnvelope(account, "segment", { entries: [row] }));
                await stagePrivateEvidence(app.context, stranded.json);
                break;
            }
            assert.ok(legacyFile.endsWith(".json"));
        }
    }
    const initial = await loadBoardState(app.context), bundleId = `export-${randomUUID()}`;
    const state = { ...initial, stateVersion: 7, globalCollection: { revision: 4, paused: true },
        nativeReportPolicy: "native-report-account-bound-v1",
        exports: [{ bundleId, kind: "report", nativeEvidenceHash: "a".repeat(64), nativeSourceBinding: { schemaVersion: 1, account: "b".repeat(64) } }],
        nativeRetention: { schemaVersion: 2, policy: "native-screened-source-observations-v1",
            configurationRevision: 2, privacyRevision: 1, settings: { paused: true, windowDays: 30 },
            surfaces: ["chat", "cowork"], accounts, partitions, receipts: [] } };
    await filesystem.writeFile(path.join(dir, `${BOARD_ID}.state.json`), JSON.stringify(state));
    await filesystem.writeFile(path.join(dir, "prior-state.snapshot.json"), JSON.stringify(state));
    const reportFolder = path.join(dir, "exports", bundleId);
    await filesystem.mkdir(reportFolder, { recursive: true });
    const reportBytes = await readFile(path.join(dir, "private-evidence", partitions[0].file));
    await filesystem.writeFile(path.join(reportFolder, "retained-fixture.json"), reportBytes);
    const backup = path.join(path.dirname(dir), "backups", `migration-${randomUUID()}`);
    await filesystem.mkdir(path.join(backup, "private-evidence"), { recursive: true });
    t.after(() => rm(backup, { recursive: true, force: true }));
    await filesystem.writeFile(path.join(dir, "migration-manifest.json"), JSON.stringify({ backup }));
    await filesystem.writeFile(path.join(backup, "migration-manifest.json"), "{}");
    await filesystem.writeFile(path.join(backup, "prior-state.snapshot.json"), JSON.stringify(state));
    for (const file of await readdir(path.join(dir, "private-evidence"))) {
        await filesystem.copyFile(path.join(dir, "private-evidence", file), path.join(backup, "private-evidence", file));
    }
    let stopAfterSeal = true;
    const deletion = createDeletionController(app.context, { afterSeal() {
        if (stopAfterSeal) throw new Error("Interrupted after durable local deletion intent.");
    } });
    const guard = await app.persistence.localActivityDeletionAdmission(app.admission);
    await assert.rejects(deletion.preview(app.owner, { scope: "all" }, { ...guard }), { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" });
    const preview = await deletion.preview(app.owner, { scope: "all" }, guard);
    assert.ok(preview.counts.records > 0);
    const publicText = JSON.stringify(preview);
    for (const account of accounts) {
        assert.equal(publicText.includes(account.partition), false);
        assert.equal(publicText.includes(account.subjectId), false);
    }
    await assert.rejects(deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }),
        { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" });
    await assert.rejects(deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }, guard),
        /Interrupted after durable local deletion intent/);
    await assert.rejects(loadBoardState(app.context), { status: 503 });
    const sealed = JSON.parse(await readFile(path.join(dir, `${BOARD_ID}.state.json`)));
    assert.equal(sealed.deletion.pending, preview.operationId);
    assert.equal(sealed.deletion.operations[preview.operationId].phase, "pending");
    assert.deepEqual(Object.keys(sealed.deletion.operations[preview.operationId].localActivityAdmission).sort(),
        ["schemaVersion", "kind", "scope", "inventoryHash"].sort());
    assert.equal(filterNativeRetainedCapture(captures[0], sealed.deletion).capture.observations.length, 0);
    assert.equal(filterNativeRetainedCapture(captures[1], sealed.deletion).capture.observations.length, 0);
    assert.deepEqual(await readGlobalCollectionGate(app.context), state.globalCollection);
    assert.deepEqual(await readNativeCollectionSettings(app.context), {
        ...state.nativeRetention.settings, configurationRevision: 2, privacyRevision: 1,
    });
    const restartedPersistence = await createNativePersistence(app.context, {
        lifecycle: app.lifecycle, transport: app.transport, preAccount: "metadata-only", configurationIntents: true,
    });
    try {
        await assert.rejects(restartedPersistence.status(), { status: 503 });
        await assert.rejects(loadBoardState(app.context), { status: 503 });
    } finally { restartedPersistence.close(); }
    stopAfterSeal = false;
    await createDeletionController(app.context).recover();
    const cleared = await loadBoardState(app.context);
    assert.equal(cleared.stateVersion, 7);
    assert.deepEqual(cleared.globalCollection, state.globalCollection);
    assert.deepEqual(cleared.nativeRetention.settings, state.nativeRetention.settings);
    assert.deepEqual(cleared.exports, state.exports);
    assert.equal(cleared.nativeReportPolicy, state.nativeReportPolicy);
    assert.equal(cleared.deletion.operations[preview.operationId].phase, "complete");
    for (const area of [dir, backup]) {
        for (const file of await readdir(path.join(area, "private-evidence"))) {
            const value = JSON.parse(await readFile(path.join(area, "private-evidence", file)));
            if (value.contractVersion === "m365-native-screened-segments-v2") {
                assert.equal(value.kind, "root");
                assert.equal(value.tree, null);
            } else assert.equal((value.observations ?? value.records).length, 0);
        }
        const recovery = JSON.parse(await readFile(path.join(area, "prior-state.snapshot.json")));
        assert.equal(recovery.stateVersion, 7);
        assert.deepEqual(recovery.globalCollection, state.globalCollection);
        assert.deepEqual(recovery.exports, state.exports);
        for (const pointer of recovery.nativeRetention.partitions) {
            assert.equal(JSON.parse(await readFile(path.join(area, "private-evidence", pointer.file))).tree, null);
        }
    }
    assert.deepEqual(await readFile(path.join(reportFolder, "retained-fixture.json")), reportBytes);
    await assert.rejects(app.lifecycle.lease("microsoft-retained"));
});

test("local deletion revocation after state fsync cannot publish tombstones or clean up source files", async t => {
    const app = await committedReportFixture(t), deletion = createDeletionController(app.context);
    let live = true;
    const guard = await app.persistence.localActivityDeletionAdmission({ ...app.admission, check: () => live });
    const preview = await deletion.preview(app.owner, { scope: "all" }, guard), before = await app.stateHash(), files = await app.files();
    const original = filesystem.open;
    let revoked = false;
    const mock = t.mock.method(filesystem, "open", async (file, ...args) => {
        const handle = await original(file, ...args);
        if (path.basename(String(file)).startsWith(".state-") && String(file).endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); live = false; revoked = true; };
        }
        return handle;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }, guard),
            { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" });
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(revoked, true);
    assert.equal(await app.stateHash(), before);
    for (const file of files) assert.ok((await app.files()).includes(file));
    const state = await loadBoardState(app.context, { readOnly: true });
    assert.equal(state.deletion?.pending, undefined);
    assert.equal(state.nativeRetention.partitions[0].file, `${app.receipt.snapshot}.json`);
});

for (const interrupted of [false, true]) test(`saved-artifact mutation owns exact account/inventory and sealed cleanup (interrupted=${interrupted})`, async t => {
    const app = await committedReportFixture(t), bundleId = `export-${randomUUID()}`;
    const bytes = await readFile(path.join(app.dataDir, "private-evidence", `${app.receipt.snapshot}.json`));
    const folder = path.join(app.dataDir, "exports", bundleId, "files");
    await filesystem.mkdir(folder, { recursive: true });
    const manifest = Buffer.from(JSON.stringify({ bundleId, snapshotHash: deletionHash(bytes), privacyReview: { reviewerConfirmed: true } }));
    const files = { "product-report.json": path.join(folder, "product-report.json"),
        "coverage-and-redaction-manifest.json": path.join(folder, "coverage-and-redaction-manifest.json") };
    await filesystem.writeFile(files["product-report.json"], bytes);
    await filesystem.writeFile(files["coverage-and-redaction-manifest.json"], manifest);
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId, kind: "report", nativeEvidenceHash: deletionHash(bytes),
            snapshotHash: deletionHash(bytes), manifestHash: deletionHash(manifest), bundleDir: folder, files, formats: ["json"] });
    });
    const before = await loadBoardState(app.context), scope = { artifactKind: "report", artifactId: bundleId };
    if (interrupted) await filesystem.writeFile(path.join(app.dataDir, "prior-state.snapshot.json"), JSON.stringify(before));
    const guard = await app.reports.artifactMutationAdmission(app.admission), describe = createSavedArtifactDescriptor(app.context);
    let escaped, binding, frozenTarget;
    await withNativeArtifactMutation(guard, app.context, app.owner, { scope, membership: null, readOnly: true }, async (state, authorization) => {
        escaped = authorization;
        assertNativeArtifactMutation(authorization, app.context, state, bundleId);
        const descriptor = await describe(state, scope, authorization);
        assertNativeArtifactMutation(authorization, app.context, state, bundleId);
        const target = await artifactDeletionPlan(app.dataDir, state, descriptor);
        assert.throws(() => bindNativeArtifactMutationPlan(authorization, app.context, state, structuredClone(target)), { status: 409 });
        frozenTarget = bindNativeArtifactMutationPlan(authorization, app.context, state, target);
        binding = nativeArtifactMutationBinding(authorization, app.context, state);
        await assert.rejects(dispatchNativeArtifactMutation(authorization, app.context, state), { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    });
    assert.throws(() => assertNativeArtifactMutation(escaped, app.context, before, bundleId), { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    await assert.rejects(withNativeArtifactMutation({ ...guard }, app.context, app.owner, { scope, membership: null, readOnly: false }, () => {}),
        { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    const localGuard = await app.persistence.localActivityDeletionAdmission(app.admission);
    await assert.rejects(withNativeArtifactMutation(localGuard, app.context, app.owner, { scope, membership: null, readOnly: false }, () => {}),
        { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    await assert.rejects(withNativeArtifactMutation(guard, app.context, app.owner, { scope, membership: null, readOnly: false }, () => "not-deleted"),
        { code: "NATIVE_ARTIFACT_MUTATION_INCOMPLETE" });
    if (!interrupted) {
        const originalState = await app.stateHash();
        try {
            await assert.rejects(withNativeArtifactMutation(guard, app.context, app.owner, { scope, membership: null, readOnly: false },
                async (state, authorization) => {
                    const target = bindNativeArtifactMutationPlan(authorization, app.context, state,
                        await artifactDeletionPlan(app.dataDir, state, await describe(state, scope, authorization)));
                    await dispatchNativeArtifactMutation(authorization, app.context, state);
                    const operationId = randomUUID(), cleanup = await stageDeletion(app.dataDir, operationId, target.actions);
                    await filesystem.writeFile(files["product-report.json"], bytes.subarray(1));
                    await sealNativeArtifactMutation(authorization, app.context, state, {
                        operationId, receiptHash: "c".repeat(64), startedAt: new Date().toISOString(), cleanup,
                    });
                }), { status: 409 });
        } finally { await filesystem.writeFile(files["product-report.json"], bytes); }
        assert.equal(await app.stateHash(), originalState);
    }
    let operationId;
    const publication = withNativeArtifactMutation(guard, app.context, app.owner, { scope, membership: null, readOnly: false },
        async (state, authorization) => {
            assert.equal(nativeArtifactMutationBinding(authorization, app.context, state), binding);
            assertNativeArtifactMutation(authorization, app.context, state, bundleId);
            const descriptor = await describe(state, scope, authorization);
            const target = bindNativeArtifactMutationPlan(authorization, app.context, state, await artifactDeletionPlan(app.dataDir, state, descriptor));
            assert.equal(deletionHash(JSON.stringify(target)), deletionHash(JSON.stringify(frozenTarget)));
            await dispatchNativeArtifactMutation(authorization, app.context, state);
            operationId = randomUUID();
            const cleanup = await stageDeletion(app.dataDir, operationId, target.actions);
            const operation = await sealNativeArtifactMutation(authorization, app.context, state, {
                operationId, receiptHash: "c".repeat(64), startedAt: new Date().toISOString(), cleanup,
            });
            assert.equal(operation.phase, "pending");
            assert.equal(state.exports.some(row => row.bundleId === bundleId), false);
            if (interrupted) throw new Error("Interrupted after artifact seal.");
            await finishDeletionFiles(app.dataDir, operation);
            await completeNativeArtifactMutation(authorization, app.context, state);
        });
    if (interrupted) await assert.rejects(publication, /Interrupted after artifact seal/);
    else await publication;
    const sealed = await loadBoardState(app.context);
    assert.equal(sealed.deletion.pending, interrupted ? operationId : undefined);
    assert.deepEqual(sealed.nativeRetention, before.nativeRetention);
    assert.equal(sealed.nativeReportPolicy, before.nativeReportPolicy);
    assert.equal(sealed.evidenceRevision, before.evidenceRevision);
    const controller = createDeletionController(app.context);
    await controller.recover();
    const after = await loadBoardState(app.context);
    assert.equal(after.deletion.operations[operationId].phase, "complete");
    assert.equal((await controller.status(operationId, app.owner)).nativeArtifactAdmission, undefined);
    for (const file of Object.values(files)) await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.deepEqual(await readFile(path.join(app.dataDir, "private-evidence", `${app.receipt.snapshot}.json`)), bytes);
    assert.equal(after.nativeReportPolicy, "native-report-account-bound-v1");
    if (interrupted) {
        const recovered = JSON.parse(await readFile(path.join(app.dataDir, "prior-state.snapshot.json")));
        assert.equal(recovered.exports.some(entry => entry.bundleId === bundleId), false);
        assert.equal(recovered.nativeReportPolicy, before.nativeReportPolicy);
    }
});

test("saved-artifact mutation rejects hidden mixed dependencies before any descriptor callback", async t => {
    const app = await committedReportFixture(t), reportId = `export-${randomUUID()}`, comparisonId = `export-${randomUUID()}`;
    const nativeId = `export-${randomUUID()}`;
    await app.reports.commit(await app.capture(), app.admission, state => {
        state.exports.push({ bundleId: nativeId, kind: "report", nativeEvidenceHash: "a".repeat(64), snapshotHash: "b".repeat(64) });
    });
    await updateBoardState(app.context, state => {
        state.exports.push({ bundleId: reportId, kind: "report", snapshotHash: "c".repeat(64) },
            { bundleId: comparisonId, kind: "comparison", nativeEvidenceHash: "d".repeat(64),
                nativeSourceBinding: { schemaVersion: 1, account: "0".repeat(64) },
                sourceReports: [{ bundleId: reportId, snapshotHash: "c".repeat(64) }, { bundleId: nativeId, snapshotHash: "b".repeat(64) }] });
    });
    const guard = await app.reports.artifactMutationAdmission(app.admission), before = await app.stateHash();
    let entered = false;
    for (const scope of [{ artifactKind: "report", artifactId: reportId }, { artifactKind: "comparison", artifactId: comparisonId }, { scope: "all-reports" }]) {
        await assert.rejects(withNativeArtifactMutation(guard, app.context, app.owner, { scope, membership: null, readOnly: true },
            () => { entered = true; }), { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
    }
    assert.equal(entered, false);
    assert.equal(await app.stateHash(), before);
});

async function selectionPublicationFixture(t, segmented = true) {
    const app = await setup(t), state = await loadBoardState(app.context), account = state.nativeRetention.accounts[0];
    const source = [...chatFixture(), ...coworkFixture()];
    for (const row of source) row.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
    await app.persistence.commit(app.begun.ticket, source);
    app.persistence.retire(app.begun.ticket);
    const initial = projectRetainedNativeRecords(await app.persistence.readAuthorized(await app.lifecycle.lease("microsoft-retained")));
    if (segmented) {
        for (const row of source) row.capture.captureId += "-publication";
        const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
        await app.persistence.commitSegmented(begun.ticket, source);
        app.persistence.retire(begun.ticket);
    }
    const saved = await loadBoardState(app.context);
    const frame = await app.persistence.reportSource.captureSelection({ revision: saved.revision,
        sources: ["microsoft-365-chat", "microsoft-365-cowork"], scenarioIds: initial.records.map(row => row.scenarioId) }, app.admission);
    const records = await app.persistence.reportSource.iterateSelection(frame, app.admission, async (events, assertCurrent) => {
        const entries = [];
        for await (const event of events) if (event.kind === "conversation-part") entries.push(...event.entries);
        assertCurrent();
        return projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries }).records;
    });
    const original = { records, source: frame.source };
    const options = normalizeReportOptions({ promptMode: segmented ? "original" : "masked", recordedContext: true, formats: ["json"] });
    const first = projectNativeReportEvidence(original, saved.pseudonymKey, options);
    const editable = first.review.filter(row => typeof row.original === "string" && row.original.length > 2);
    assert.ok(editable.length >= 2);
    options.manualTerms = ["invented"];
    options.overrides = [{ key: editable[0].key, text: editable[0].original.slice(0, -1) }, { key: editable[1].key, omit: true }];
    const projected = projectNativeReportEvidence(original, saved.pseudonymKey, options);
    const preparedAt = new Date().toISOString(), bundleId = `export-${randomUUID()}`;
    const snapshot = { schemaVersion: 3, kind: "report", bundleId, preparedAt, promptMode: options.promptMode,
        formats: options.formats, timeContext: options.timeContext, preparedAtDisplay: time.formatTime(preparedAt, options.timeContext),
        dateSelection: options.dateSelection, dateRange: time.range(options.dateSelection, options.timeContext.timeZone),
        records: projected.records, nativeEvidence: projected.nativeEvidence, presentation: currentReportPresentation };
    const bundle = { kind: "report", bundleId, snapshot, formats: options.formats,
        privacy: { reviewerConfirmed: true, confirmedAt: preparedAt }, files: {} };
    function refresh() {
        const text = JSON.stringify(snapshot, null, 2) + "\n";
        const manifest = { ...snapshot, snapshotHash: deletionHash(JSON.stringify(snapshot)),
            nativeEvidenceHash: deletionHash(JSON.stringify(snapshot.nativeEvidence)), privacyReview: bundle.privacy,
            files: { "product-report.json": { sha256: deletionHash(text), bytes: Buffer.byteLength(text) } } };
        delete manifest.records;
        bundle.files = { "product-report.json": text, "coverage-and-redaction-manifest.json": JSON.stringify(manifest, null, 2) };
    }
    refresh();
    const publication = { bundle, async validate(current, assertCurrent) {
        assert.equal(current.pseudonymKey, saved.pseudonymKey);
        assert.equal(bundle.privacy.reviewerConfirmed, true);
        await Promise.resolve();
        assertCurrent();
    } };
    async function write(current, assertCurrent) {
        const folder = path.join(app.dataDir, "exports", bundleId, "files");
        await filesystem.mkdir(folder, { recursive: true });
        for (const [name, bytes] of Object.entries(bundle.files)) {
            assertCurrent(); await writeExclusive(path.join(folder, name), bytes); assertCurrent();
        }
        const entry = { bundleId, kind: "report", preparedAt, exportedAt: new Date().toISOString(), bundleDir: folder,
            privacyReview: { reviewerConfirmed: true, reviewerIdentityVerified: false, confirmedAt: bundle.privacy.confirmedAt },
            promptMode: snapshot.promptMode, formats: snapshot.formats, timeContext: snapshot.timeContext,
            preparedAtDisplay: snapshot.preparedAtDisplay, snapshotHash: deletionHash(JSON.stringify(snapshot)),
            manifestHash: deletionHash(bundle.files["coverage-and-redaction-manifest.json"]),
            nativeEvidenceHash: deletionHash(JSON.stringify(snapshot.nativeEvidence)),
            files: Object.fromEntries(Object.keys(bundle.files).map(name => [name, path.join(folder, name)])), scenarioIds: [] };
        current.exports.push(entry);
        current.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
        current.artifactDeletion.revision++;
        return entry;
    }
    return { ...app, frame, bundle, publication, write, refresh, saved };
}

for (const segmented of [false, true]) test(`selection publication binds reviewed edits/omissions and immutable native facts (v2=${segmented})`, async t => {
    const app = await selectionPublicationFixture(t, segmented), before = await app.stateHash();
    let called = false;
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, () => { called = true; }),
        { code: "NATIVE_REPORT_SELECTION_PUBLICATION_NOT_READY" });
    assert.equal(called, false);
    assert.equal(await app.stateHash(), before);
    const copies = app.bundle.snapshot.nativeEvidence.disclosure.copies;
    assert.ok(copies.some(copy => copy.representation === "edited-copy"));
    assert.ok(copies.some(copy => copy.omitted));
    const result = await app.persistence.reportSource.commit(app.frame, app.admission, app.write, app.publication);
    assert.equal(result.state.stateVersion, segmented ? 7 : 5);
    assert.equal(result.state.artifactDeletion.revision, 1);
    const written = (await loadBoardState(app.context)).exports.at(-1);
    assert.equal(written.manifestHash, deletionHash(app.bundle.files["coverage-and-redaction-manifest.json"]));
    assert.equal(written.nativeEvidenceHash, deletionHash(JSON.stringify(app.bundle.snapshot.nativeEvidence)));
    assert.equal(Object.hasOwn(written, "evaluationFactsHash"), false);
    assert.ok(written.nativeSourceBinding);
    assert.deepEqual(await app.persistence.reportSource.readSaved({ bundleIds: [written.bundleId] }, app.admission,
        (_state, entries) => entries.map(entry => Object.hasOwn(entry, "nativeSourceBinding"))), [false]);
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, app.write, app.publication),
        { code: "NATIVE_REPORT_FRAME_CONSUMED" });
});

test("selection publication rejects changed native facts and failed async dependencies before writing", async t => {
    const app = await selectionPublicationFixture(t), before = await app.stateHash();
    let called = false;
    const work = () => { called = true; };
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, work, { ...app.publication,
        async validate(_state, assertCurrent) { await Promise.resolve(); assertCurrent(); throw new Error("Original dependency changed."); } }),
    /Original dependency changed/);
    app.bundle.snapshot.nativeEvidence.conversations[0].observations[0].captureCount++;
    app.refresh();
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, work, app.publication),
        { code: "NATIVE_REPORT_PUBLICATION_INVALID" });
    assert.equal(called, false);
    assert.equal(await app.stateHash(), before);
});

test("selection publication keeps partial files and consumes the frame when written index association is wrong", async t => {
    const app = await selectionPublicationFixture(t), before = await app.stateHash();
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, async (state, assertCurrent) => {
        await app.write(state, assertCurrent);
        state.exports.at(-1).nativeEvidenceHash = "0".repeat(64);
    }, app.publication), { code: "NATIVE_REPORT_PUBLICATION_INVALID" });
    assert.equal(await app.stateHash(), before);
    assert.ok((await readFile(path.join(app.dataDir, "exports", app.bundle.bundleId, "files", "product-report.json"))).length > 0);
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, app.write, app.publication),
        { code: "NATIVE_REPORT_FRAME_CONSUMED" });
});

for (const boundary of ["state-fsync", "committed-readback"]) test(`selection publication preserves uncertainty at ${boundary}`, async t => {
    const app = await selectionPublicationFixture(t), before = await app.stateHash(), original = filesystem.open;
    let live = true, reached = false;
    const request = { ...app.admission, check: () => live };
    const mock = t.mock.method(filesystem, "open", async (file, ...args) => {
        const name = path.basename(String(file));
        if (boundary === "committed-readback" && name === `${BOARD_ID}.state.json` && args[0] === "r") {
            reached = true;
            throw Object.assign(new Error("Owned fixture readback interruption."), { code: "EIO" });
        }
        const handle = await original(file, ...args);
        if (boundary === "state-fsync" && name.startsWith(".state-") && name.endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); reached = true; live = false; };
        }
        return handle;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(app.persistence.reportSource.commit(app.frame, request, app.write, app.publication),
            { code: boundary === "state-fsync" ? "NATIVE_RETENTION_REQUEST_REVOKED" : "EIO" });
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(reached, true);
    const saved = await loadBoardState(app.context);
    assert.equal(saved.exports.some(entry => entry.bundleId === app.bundle.bundleId), boundary === "committed-readback");
    if (boundary === "state-fsync") assert.equal(await app.stateHash(), before);
    assert.ok((await readFile(path.join(app.dataDir, "exports", app.bundle.bundleId, "files", "product-report.json"))).length > 0);
    await assert.rejects(app.persistence.reportSource.commit(app.frame, app.admission, app.write, app.publication),
        { code: "NATIVE_REPORT_FRAME_CONSUMED" });
});
