import test from "node:test";
import assert from "node:assert/strict";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { committedNativeReportFixture, savedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { createNativeRetainedRead } from "../lib/native-retained-read.mjs";

test("native frozen Search validates account authority at scan and publication without nested queues", { timeout: 15000 }, async t => {
    const app = await committedNativeReportFixture(t);
    const saved = await savedNativeReportFixture(app, { formats: ["html"] });
    const source = () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 });
    const nativeReader = createNativeRetainedRead(app.lifecycle, app.persistence.readAuthorized);
    t.after(() => nativeReader.close());
    const corpus = createCorpusSources(app.context, { source, nativeReader, reportContext: app.services });
    const indexed = await corpus.scan();
    const report = indexed.entries.find(entry => entry.type === "report");
    assert.equal(report.target.bundleId, saved.bundle.bundleId);
    assert.match(report.content, /Read the invented records/);
    let published = false;
    await corpus.current(indexed, () => { published = true; });
    assert.equal(published, true);
    assert.equal(nativeReader.assertCurrent(indexed.native), true);
    assert.throws(() => nativeReader.assertCurrent(structuredClone(indexed.native)), { code: "native-read-frame-invalid" });
    await assert.rejects(corpus.current(indexed, async () => { throw new Error("Rejected async test publisher"); }),
        { code: "native-report-publication-must-be-synchronous" });
    await assert.rejects(createCorpusSources(app.context, { source }).scan(), { code: "NATIVE_REPORT_RUNTIME_REQUIRED" });
    app.services.nativeReportAdmission.check = () => false;
    await assert.rejects(corpus.current(indexed, () => assert.fail("Revoked native report must not publish")), { code: "NATIVE_RETENTION_REQUEST_REVOKED" });
});

test("native runtime Search uses synchronous publication even before any native report is saved", async t => {
    const app = await committedNativeReportFixture(t);
    const reader = createNativeRetainedRead(app.lifecycle, app.persistence.readAuthorized);
    t.after(() => reader.close());
    const corpus = createCorpusSources(app.context, {
        source: () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 }),
        reportContext: app.services,
        nativeReader: { ...reader, publish() { assert.fail("Publication must not enter lifecycle admission from the board queue."); } },
    });
    const frame = await corpus.scan();
    assert.equal(frame.hasNativeArtifacts, false);
    assert.equal(await corpus.current(frame, () => true), true);
});
