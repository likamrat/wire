import test from "node:test";
import assert from "node:assert/strict";
import { createExportController, writeBundle } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { readSavedArtifactFile, readSavedComparison, createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { committedNativeReportFixture, savedNativeReportFixture, preserveReportProof } from "./native-report-controller-fixture.mjs";
import { fixture } from "./helpers.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

test("Microsoft saved comparison uses reviewed publication and account-authorized immutable readers", async t => {
    const app = await committedNativeReportFixture(t);
    const a = await savedNativeReportFixture(app, { title: "Earlier Microsoft activity", promptMode: "original", recordedContext: true, formats: ["html"] });
    const b = await savedNativeReportFixture(app, { title: "Later Microsoft activity", promptMode: "none", formats: ["markdown"] });
    const controller = createExportController(app.context), { owner, services } = app;
    const prepared = await controller.previewComparison(owner, a.bundle.bundleId, b.bundle.bundleId,
        { title: "Microsoft activity comparison", formats: ["html", "json", "markdown"] }, services);
    assert.equal(prepared.comparison.status, "ready");
    assert.match(prepared.previewHtml, /Microsoft 365 Cowork/);
    assert.match(prepared.files["comparison-report.md"], /Microsoft 365 Cowork: Tool calls \| 3 \| 3 \| 0/);
    assert.ok(prepared.snapshot.sourceFacts.every(source => source.legacyFacts.nativeEvidence.disclosure.copies.every(copy => copy.text === null)));
    await assert.rejects(controller.confirmComparison(owner, prepared.previewId, true, undefined, services), /disclosure review/);
    const reviewed = await controller.reviewComparison(owner, prepared.previewId, true, undefined, services);
    const saved = (await controller.confirmComparison(owner, prepared.previewId, true, undefined, services)).bundle;
    assert.ok(saved.nativeComparisonHash);
    const raw = await loadBoardState(app.context);
    assert.ok(raw.exports.find(entry => entry.bundleId === saved.bundleId).nativeSourceBinding);
    await assert.rejects(readSavedComparison(app.context, raw, saved.bundleId), /account-authorized/);
    await services.nativeReportSource.readSaved({ bundleIds: [saved.bundleId] }, services.nativeReportAdmission, async state => {
        for (const format of ["html", "json", "markdown", "manifest"]) {
            const file = await readSavedArtifactFile(app.context, state, saved.bundleId, "comparison", format);
            assert.equal(file.bytes.toString(), reviewed.files[file.name]);
        }
        assert.deepEqual((await readSavedComparison(app.context, state, saved.bundleId)).comparison, reviewed.comparison);
    });

    await assert.rejects(controller.confirmComparison(owner, prepared.previewId, true, undefined, services), /no longer available/);
    const deletion = createDeletionController(app.context, { describeSavedArtifact: createSavedArtifactDescriptor(app.context) });
    for (const [artifactId, artifactKind] of [[a.bundle.bundleId, "report"], [saved.bundleId, "comparison"]]) {
        const guard = await services.nativeReportSource.artifactMutationAdmission(services.nativeReportAdmission);
        const preview = await deletion.previewArtifact(owner, { artifactId, artifactKind }, guard);
        await deletion.confirmArtifact(owner, { operationId: preview.operationId, confirmed: true }, guard);
        if (artifactKind === "report") await services.nativeReportSource.readSaved({ bundleIds: [saved.bundleId] },
            services.nativeReportAdmission, async state => {
                const original = await readSavedArtifactFile(app.context, state, saved.bundleId, "comparison", "html");
                assert.equal(original.bytes.toString(), reviewed.files[original.name]);
            });
    }
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, raw.nativeRetention);
});

test("mixed comparisons preserve GitHub measures beside Microsoft populations in all formats", async t => {
        const app = await committedNativeReportFixture(t);
        await replaceEvidence(app.context, () => ({ records: [fixture("mixed-comparison")], importCoverage: {} }));
        const a = await savedNativeReportFixture(app, { promptMode: "original", formats: ["html"] }, { github: true });
        const b = await savedNativeReportFixture(app, { promptMode: "none", formats: ["markdown"] }, { github: true });
        const controller = createExportController(app.context), { owner, services } = app;
        const prepared = await controller.previewComparison(owner, a.bundle.bundleId, b.bundle.bundleId,
            { formats: ["html", "json", "markdown", "pdf"] }, services);
        assert.equal(prepared.comparison.toolComparison.raw.baseline.count, 1);
        assert.ok(prepared.comparison.nativeComparison.units.some(row => row.unit === "native-tool-call" && row.baselineCount > 0));
        assert.doesNotMatch(prepared.files["comparison-report.json"], /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP/);
        assert.match(prepared.previewHtml, /Result text was not selected for this comparison/);
        assert.doesNotMatch(prepared.previewHtml, /0 masked copies included/);
        await preserveReportProof("native-comparison-report", prepared);
        const task = getDocument({ data: new Uint8Array(Buffer.from(prepared.files["comparison-report.pdf"].data, "base64")) });
        try {
            const pdf = await task.promise, pages = [];
            for (let index = 1; index <= pdf.numPages; index++) pages.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str ?? "").join(" "));
            assert.match(pages.join("\n"), /Microsoft 365 Cowork/);
            assert.match(pages.join("\n"), /Recorded tool/);
        } finally { await task.destroy(); }
});

for (const phase of ["before", "after"]) test(`Microsoft comparison revocation ${phase} writer never confirms or replays`, async t => {
    const app = await committedNativeReportFixture(t);
    const a = await savedNativeReportFixture(app, { title: "Earlier", promptMode: "none" });
    const b = await savedNativeReportFixture(app, { title: "Later", promptMode: "none" });
    let revoked = false, writes = 0;
    const services = { ...app.services, nativeReportAdmission: { ...app.services.nativeReportAdmission,
        check() { if (revoked) throw Object.assign(new Error("fixture-request-withdrawn"), { status: 403 }); } } };
    const controller = createExportController(app.context, async (...args) => {
        writes++;
        const result = await writeBundle(...args);
        if (phase === "after") revoked = true;
        return result;
    });
    const preview = await controller.previewComparison(app.owner, a.bundle.bundleId, b.bundle.bundleId, {}, services);
    await controller.reviewComparison(app.owner, preview.previewId, true, undefined, services);
    if (phase === "before") revoked = true;
    await assert.rejects(controller.confirmComparison(app.owner, preview.previewId, true, undefined, services),
        phase === "after" ? { code: "NATIVE_REPORT_SAVE_UNCONFIRMED" } : /fixture-request-withdrawn/);
    assert.equal(writes, phase === "after" ? 1 : 0);
    assert.equal((await loadBoardState(app.context)).exports.length, 2);
    revoked = false;
    await assert.rejects(controller.confirmComparison(app.owner, preview.previewId, true, undefined, services), /no longer available/);
});

test("Microsoft comparison source mutation and foreign owner cannot reuse review authority", async t => {
    const app = await committedNativeReportFixture(t);
    const a = await savedNativeReportFixture(app, { title: "Earlier", promptMode: "none" });
    const b = await savedNativeReportFixture(app, { title: "Later", promptMode: "none" });
    const controller = createExportController(app.context, () => assert.fail("A stale source cannot dispatch a writer."));
    const preview = await controller.previewComparison(app.owner, a.bundle.bundleId, b.bundle.bundleId, {}, app.services);
    await assert.rejects(controller.reviewComparison("another-owner", preview.previewId, true, undefined, app.services), /no longer available/);
    await controller.reviewComparison(app.owner, preview.previewId, true, undefined, app.services);
    await updateBoardState(app.context, state => { state.exports.find(entry => entry.bundleId === a.bundle.bundleId).title = "Changed title"; });
    await assert.rejects(controller.confirmComparison(app.owner, preview.previewId, true, undefined, app.services), /changed|stale/i);
});
