import test from "node:test";
import assert from "node:assert/strict";
import { createExportController, isReviewedNativeReportController, writeBundle } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { readSavedReportFile, loadSavedReportSource, SAVED_REPORT_MAX_BYTES } from "../lib/report-artifacts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { committedNativeReportFixture as committed, savedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { fixture } from "./helpers.mjs";

import { nativeCallsSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { projectNativeReportEvidence } from "../lib/native-report-evidence.mjs";
import { readFile } from "node:fs/promises";
import { createDeletionController } from "../lib/deletion.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";

const selectedNative = (app, revision, extraIds = []) => ({ kind: "selected", revision,
    scenarioIds: [...extraIds, ...app.services.nativeRecords.map(record => record.scenarioId)] });

test("reviewed publication availability requires the exact controller, session and original methods", () => {
    const session = {}, controller = createExportController(session);
    assert.equal(isReviewedNativeReportController(controller, session), true);
    assert.equal(isReviewedNativeReportController({ ...controller }, session), false);
    assert.equal(isReviewedNativeReportController(controller, { ...session }), false);
    for (const method of ["preview", "review", "confirm"]) {
        const original = controller[method];
        controller[method] = (...args) => original(...args);
        assert.equal(isReviewedNativeReportController(controller, session), false);
        controller[method] = original;
    }
    assert.equal(isReviewedNativeReportController(controller, session), true);
});

test("normal source Save refusal still blocks the reviewed publication caller before its writer", async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    let writes = 0;
    const controller = createExportController(app.context, () => { writes++; assert.fail("Selection saving is not admitted"); });
    app.services.nativeReportAdmission.dispatched = () => {
        throw Object.assign(new Error("Native report saving is not admitted by this source route."), { status: 503, code: "NATIVE_REPORT_SAVE_UNAVAILABLE" });
    };
    const preview = await controller.preview(app.owner, undefined, { formats: ["html", "json"], promptMode: "none" },
        selectedNative(app, before.revision), undefined, app.services);
    assert.ok(preview.snapshot.nativeEvidence);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services), /disclosure review/);
    await controller.review(app.owner, preview.previewId, true, undefined, app.services);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, {
        ...app.services, commitMutation() { throw new Error("Native save must not enter generic admission"); },
    }), { status: 503, code: "NATIVE_REPORT_SAVE_UNAVAILABLE" });

    const disk = await loadBoardState(app.context);
    assert.equal(disk.revision, before.revision);
    assert.equal(disk.exports.length, 0);
    assert.equal(writes, 0);
    assert.doesNotMatch(JSON.stringify(preview), /nativeSourceBinding|originalViewExpectations|rootHash|selectionRef/);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services), /not found/);
});

test("native no-JSON saves reopen and expose frozen manifest Search text only within an authorized artifact read", async t => {
    const app = await committed(t), saved = await savedNativeReportFixture(app, { formats: ["html"] });
    await assert.rejects(readSavedReportFile(app.context, await loadBoardState(app.context), saved.bundle.bundleId), { status: 403 });
    const read = await app.persistence.reportSource.readSaved({ bundleIds: [saved.bundle.bundleId] },
        app.services.nativeReportAdmission, async state => {
            const document = await readSavedReportFile(app.context, state, saved.bundle.bundleId);
            const source = await loadSavedReportSource(app.context, state, saved.bundle.bundleId);
            return { source, content: await extractReportFile(document) };
        });
    assert.deepEqual(read.source.nativeEvidence, saved.snapshot.nativeEvidence);
    assert.equal(read.content.coverage.nativeEvidence, "frozen-manifest-v1");
    assert.match(read.content.content, /Read the invented records/);
    assert.doesNotMatch(read.content.content, /invented-subject|invented-tenant|RAW_/);
});

test("native report capture rejects copied authority and optimistic source replacement", async t => {
    const app = await committed(t), before = await loadBoardState(app.context), controller = createExportController(app.context);
    const scope = selectedNative(app, before.revision);
    await assert.rejects(controller.preview(app.owner, undefined, {}, scope, undefined,
        { ...app.services, nativeReportSource: { ...app.services.nativeReportSource } }), { status: 503 });
    const changed = structuredClone(app.services.nativeRecords);
    changed[0].nativeConversation.messages[0].value.text = "Changed optimistic selection";
    await assert.rejects(controller.preview(app.owner, undefined, {}, scope, undefined,
        { ...app.services, nativeRecords: changed }), { status: 409 });
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

test("mixed controller publishes against locked GitHub evidence and keeps metric facts inside the native namespace", async t => {
    const app = await committed(t);
    await replaceEvidence(app.context, () => ({ records: [fixture("mixed-github")], importCoverage: {} }));
    const controller = createExportController(app.context), before = await loadBoardState(app.context);
    const preview = await controller.preview(app.owner, undefined, { formats: ["html", "json"], promptMode: "none" },
        selectedNative(app, before.revision, ["mixed-github"]), undefined, app.services);
    assert.equal(preview.snapshot.records.length, 2);
    assert.equal(preview.snapshot.nativeEvidence.githubEvaluationFacts.metricProjectionVersion, 4);
    assert.equal(Object.hasOwn(preview.snapshot, "evaluationFacts"), false);
    await controller.review(app.owner, preview.previewId, true, undefined, app.services);
    const saved = await controller.confirm(app.owner, preview.previewId, true, undefined, app.services);
    assert.equal(saved.bundle.nativeSourceBinding, undefined);
    assert.equal(saved.bundle.evaluationFactsHash, undefined);
    const opened = await app.persistence.reportSource.readSaved({ bundleIds: [saved.bundle.bundleId] },
        app.services.nativeReportAdmission, state => loadSavedReportSource(app.context, state, saved.bundle.bundleId));
    assert.deepEqual(opened.nativeEvidence, preview.snapshot.nativeEvidence);
});

test("native request revocation after bounded preparation prevents disclosure and any writer dispatch", async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    const controller = createExportController(app.context, () => assert.fail("No native writer dispatch"));
    const preview = await controller.preview(app.owner, undefined, { formats: ["json"], promptMode: "none" },
        selectedNative(app, before.revision), undefined, app.services);
    app.services.nativeReportAdmission.check = () => false;
    await assert.rejects(controller.review(app.owner, preview.previewId, true, undefined, app.services),
        { status: 403, code: "NATIVE_RETENTION_REQUEST_REVOKED" });
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services), /disclosure review/);
});

test("native format preparation rejects files beyond the exact saved-reader bound before saving anything", async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    const controller = createExportController(app.context, writeBundle, async () => {
        const bytes = Buffer.alloc(SAVED_REPORT_MAX_BYTES + 1);
        bytes.write("%PDF-");
        return bytes;
    });
    await assert.rejects(controller.preview(app.owner, undefined, { formats: ["pdf"], promptMode: "none" },
        selectedNative(app, before.revision), undefined, app.services),
    error => error.status === 422 && /saved-file size/.test(error.message));
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

test("unqualified native All and Current membership is not fabricated from supplied page records", async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    const controller = createExportController(app.context);
    for (const selection of [{ kind: "all", revision: before.revision },
        { ...selectedNative(app, before.revision), kind: "current" }]) {
        await assert.rejects(controller.preview(app.owner, undefined, {}, selection, undefined, app.services),
            error => error.status === 503 && /All and Current/.test(error.message));
    }
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

for (const segmented of [false, true]) test(`bounded ${segmented ? "v2" : "v1"} controller publishes exact reviewed bytes once and supports distinct authorized deletion`, async t => {
    const envelopes = [...retainNativeChatSourceObservations(decodeNativeChatObservation(nativeCallsSource())), ...coworkFixture()];
    const app = await committed(t, { envelopes, segmented }), before = await loadBoardState(app.context);
    const chosen = app.services.nativeRecords.filter(record => record.sourceId === "microsoft-365-cowork");
    assert.ok(chosen[0].nativeConversation.observations[0].inputOrdinal > 0);
    assert.ok(app.services.nativeDefinitions.sourceObservationPopulation);
    const scope = { kind: "selected", revision: before.revision, scenarioIds: chosen.map(record => record.scenarioId) };
    const frame = await app.persistence.reportSource.captureSelection({
        revision: before.revision, sources: ["microsoft-365-cowork"], scenarioIds: scope.scenarioIds,
    }, app.services.nativeReportAdmission);
    const expected = projectNativeReportEvidence({ records: chosen, source: frame.source }, before.pseudonymKey, { promptMode: "none" });
    let writes = 0;
    const controller = createExportController(app.context, async (...args) => { writes++; return writeBundle(...args); });
    const preview = await controller.preview(app.owner, undefined, { formats: ["html", "json"], promptMode: "none" },
        scope, undefined, app.services);
    assert.deepEqual(preview.snapshot.nativeEvidence, expected.nativeEvidence);
    const reviewed = await controller.review(app.owner, preview.previewId, true, undefined, app.services);
    assert.equal(reviewed.privacy.reviewerConfirmed, true);
    const serialized = JSON.stringify(reviewed);
    assert.doesNotMatch(serialized, /nativeSourceBinding|originalViewExpectations|rootHash|selectionRef|inputOrdinal/);
    assert.equal(serialized.includes(before.nativeRetention.partitions[0].file.slice(0, -5)), false);
    const saved = await controller.confirm(app.owner, preview.previewId, true, undefined, app.services);
    assert.equal(writes, 1);
    for (const [name, bytes] of Object.entries(reviewed.files)) assert.equal(await readFile(saved.bundle.files[name], "utf8"), bytes);
    const persisted = await loadBoardState(app.context);
    assert.equal(persisted.revision, before.revision + 1);
    assert.equal(persisted.stateVersion, segmented ? 7 : 5);
    assert.equal(persisted.nativeReportPolicy, "native-report-account-bound-v1");
    assert.ok(persisted.exports[0].nativeSourceBinding);
    assert.equal(Object.hasOwn(saved.bundle, "nativeSourceBinding"), false);
    assert.deepEqual(persisted.nativeRetention, before.nativeRetention);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services), { status: 409 });
    const opened = await app.persistence.reportSource.readSaved({ bundleIds: [saved.bundle.bundleId] },
        app.services.nativeReportAdmission, state => loadSavedReportSource(app.context, state, saved.bundle.bundleId));
    assert.deepEqual(opened.nativeEvidence, preview.snapshot.nativeEvidence);
    const deletion = createDeletionController(app.context, { describeSavedArtifact: createSavedArtifactDescriptor(app.context),
        onSeal() { controller.invalidateDerived(); } });
    const guard = await app.persistence.reportSource.artifactMutationAdmission(app.services.nativeReportAdmission);
    const removed = await deletion.previewArtifact(app.owner, { artifactKind: "report", artifactId: saved.bundle.bundleId }, guard);
    await deletion.confirmArtifact(app.owner, { operationId: removed.operationId, confirmed: true }, guard);
    const remaining = await loadBoardState(app.context);
    assert.equal(remaining.exports.length, 0);
    assert.equal(remaining.nativeReportPolicy, persisted.nativeReportPolicy);
    assert.deepEqual(remaining.nativeRetention, before.nativeRetention);
});

test("native selection rendering rechecks its genuine source stamp before publishing a preview", async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    const controller = createExportController(app.context, writeBundle, async () => {
        await app.persistence.configure({ expectedRevision: before.nativeRetention.configurationRevision,
            surfaces: ["chat", "cowork"], windowDays: 7 }, app.services.nativeReportAdmission);
        return Buffer.from("%PDF-synthetic-renderer-output");
    });
    await assert.rejects(controller.preview(app.owner, undefined, { formats: ["pdf"], promptMode: "none" },
        selectedNative(app, before.revision), undefined, app.services), { code: "NATIVE_REPORT_SOURCE_STALE" });
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

test("reviewed native edit/omit/manual removal publishes all four exact formats through the original controller", async t => {
    const app = await committed(t, { envelopes: [...chatFixture(), ...coworkFixture()] }), before = await loadBoardState(app.context);
    const controller = createExportController(app.context), scope = selectedNative(app, before.revision);
    const options = { formats: ["html", "json", "markdown", "pdf"], promptMode: "original", recordedContext: true };
    const first = await controller.preview(app.owner, undefined, { ...options, formats: ["html"] }, scope, undefined, app.services);
    const edited = first.nativeReview.find(copy => copy.author === "user"), omitted = first.nativeReview.find(copy => copy.author === "assistant");
    const next = await controller.preview(app.owner, undefined, { ...options, manualTerms: ["invented"], overrides: [
        { key: edited.key, text: edited.original.replace("An invented", "A reviewed") }, { key: omitted.key, omit: true },
    ] }, scope, undefined, app.services);
    await assert.rejects(controller.review(app.owner, first.previewId, true, undefined, app.services), { status: 409 });
    const reviewed = await controller.review(app.owner, next.previewId, true, undefined, app.services);
    const saved = await controller.confirm(app.owner, next.previewId, true, undefined, app.services);
    for (const [name, file] of Object.entries(reviewed.files)) {
        assert.deepEqual(await readFile(saved.bundle.files[name]), typeof file === "string" ? Buffer.from(file) : Buffer.from(file.data, "base64"));
    }
    const snapshot = JSON.parse(await readFile(saved.bundle.files["product-report.json"], "utf8"));
    assert.equal(snapshot.nativeEvidence.disclosure.copies.find(copy => copy.key === omitted.key).omitted, true);
    assert.equal(snapshot.nativeEvidence.disclosure.copies.find(copy => copy.key === edited.key).representation, "edited-copy");
    assert.ok(snapshot.nativeEvidence.disclosure.copies.some(copy => copy.changes.some(change => change.category === "manual")));
    const frozen = await app.persistence.reportSource.readSaved({ bundleIds: [saved.bundle.bundleId] },
        app.services.nativeReportAdmission, async state => extractReportFile(await readSavedReportFile(app.context, state, saved.bundle.bundleId)));
    assert.match(frozen.content, /A reviewed question/);
    assert.doesNotMatch(frozen.content, /First invented reply/);
    assert.equal((await loadBoardState(app.context)).exports.length, 1);
});

for (const invalidate of ["generation", "expiry", "request"]) test(`native ${invalidate} withdrawal after file writing remains unconfirmed and cannot replay`, async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    let written, writes = 0;
    const controller = createExportController(app.context, async (...args) => {
        writes++;
        written = await writeBundle(...args);
        if (invalidate === "generation") controller.discard(app.owner);
        else if (invalidate === "expiry") {
            const expired = Date.now() + 11 * 60000;
            t.mock.method(Date, "now", () => expired);
        } else app.services.nativeReportAdmission.check = () => false;
        return written;
    });
    const preview = await controller.preview(app.owner, undefined, { formats: ["json"], promptMode: "none" },
        selectedNative(app, before.revision), undefined, app.services);
    await controller.review(app.owner, preview.previewId, true, undefined, app.services);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services),
        { status: 500, code: "NATIVE_REPORT_SAVE_UNCONFIRMED" });
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
    assert.ok((await readFile(written.files["product-report.json"])).length);
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services), { status: 409 });
    assert.equal(writes, 1);
});

test("replacing the original native review while confirmation awaits admission prevents dispatch", async t => {
    const app = await committed(t), before = await loadBoardState(app.context);
    let dispatched = 0;
    app.services.nativeReportAdmission.dispatched = () => { dispatched++; };
    const controller = createExportController(app.context, () => assert.fail("Replaced preview cannot write"));
    const preview = await controller.preview(app.owner, undefined, { formats: ["json"], promptMode: "none" },
        selectedNative(app, before.revision), undefined, app.services);
    await controller.review(app.owner, preview.previewId, true, undefined, app.services);
    const rejected = assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, app.services), { status: 409 });
    controller.discard(app.owner);
    await rejected;
    assert.equal(dispatched, 0);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});
