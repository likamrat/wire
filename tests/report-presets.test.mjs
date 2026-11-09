import test from "node:test";
import assert from "node:assert/strict";
import { createExportController, buildSanitizedRecord } from "../lib/export.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { assertProjectedBundle } from "../lib/privacy.mjs";
import { normalizeReportOptions } from "../lib/prompt-projection.mjs";
import { time } from "../lib/time.mjs";
import { readSavedArtifactFile, loadSavedReportSource } from "../lib/report-artifacts.mjs";
import { inspectSavedReportSnapshot } from "../lib/saved-report-snapshot.mjs";
import { startServer } from "../lib/server.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";

const timeContext = { timeZone: "America/Los_Angeles", locale: "en-US" };
function records() {
    return ["failed", "completed", "unknown"].map((id, index) => {
        const record = fixture(id);
        record.userPrompt.text = `SYNTHETIC_${id.toUpperCase()}_PROMPT owner: Example Person email@example.invalid`;
        record.capturedAt = "2026-11-04T20:00:00Z";
        record.toolCalls[0].startedAt = record.capturedAt;
        Object.assign(record.toolCalls[0], {
            toolSucceeded: index === 0 ? false : index === 1 ? true : null,
            reportedOutcome: index === 0 ? "failed" : index === 1 ? "succeeded" : "unknown",
            apiResults: [{ index: 0, statusCode: index === 0 ? 403 : index === 1 ? 200 : null }],
        });
        return record;
    });
}
const options = () => ({
    promptMode: "masked", formats: ["html", "json", "markdown"], timeContext,
    dateSelection: { range: "7", from: "2026-11-02", to: "2026-11-08" },
    reportFocus: { version: 1, preset: "errors", outcome: "errors", services: [] },
    saveMode: "local",
});

test("normal preparation freezes error membership, the wider total and separately authored masked notes", async t => {
    const source = records(), { context } = await privateFixture(t, source);
    const before = await loadBoardState(context), controller = createExportController(context);
    const selection = { kind: "all", revision: before.revision };
    const id = buildSanitizedRecord(source[0], before.pseudonymKey).scenarioId;
    const preview = await controller.preview("report-owner", undefined, {
        ...options(), reportNotes: [{ scenarioId: id, text: "Contact note@example.invalid. password='NOTE_SECRET' The request could not read the mailbox." }],
    }, selection);
    assert.equal(preview.records.length, 1);
    assert.equal(preview.snapshot.reportPopulation.reference.length, 3);
    assert.deepEqual(preview.snapshot.reportPopulation.included, [id]);
    assert.equal(preview.snapshot.reportNotes.author, "report-author");
    const note = preview.snapshot.reportNotes.entries[0];
    assert.match(note.text, /could not read the mailbox/);
    assert.doesNotMatch(note.text, /note@example.invalid|NOTE_SECRET/);
    assert.equal(preview.privacy.reviewerConfirmed, false);
    assert.equal(preview.localSaveRequest.bundleId, preview.bundleId);
    assert.equal(assertProjectedBundle(preview).blockedCategoryCount, 0);
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const json = JSON.parse(preview.files["product-report.json"]);
    assert.deepEqual(json.reportNotes, preview.snapshot.reportNotes);
    assert.equal(JSON.stringify(json).includes("SYNTHETIC_COMPLETED_PROMPT"), false);
    const changed = structuredClone(preview);
    changed.snapshot.reportPopulation.reference.pop();
    assert.throws(() => assertProjectedBundle(changed), /integrity/);
});

test("notes cannot bring excluded interactions into a report and no-prompts mode still masks authored notes", async t => {
    const source = records(), { context } = await privateFixture(t, source);
    const state = await loadBoardState(context), controller = createExportController(context);
    const selection = { kind: "all", revision: state.revision };
    const outside = buildSanitizedRecord(source[1], state.pseudonymKey).scenarioId;
    await assert.rejects(controller.preview("owner", undefined, {
        ...options(), reportNotes: [{ scenarioId: outside, text: "Excluded example" }],
    }, selection), /no longer included/);
    const inside = buildSanitizedRecord(source[0], state.pseudonymKey).scenarioId;
    const preview = await controller.preview("owner", undefined, {
        ...options(), promptMode: "none", reportNotes: [{ scenarioId: inside, text: "Contact note@example.invalid about this example." }],
    }, selection);
    assert.ok(preview.records.every(record => record.prompts.every(prompt => prompt.text === null)));
    assert.equal(preview.snapshot.reportNotes.mode, "masked");
    assert.doesNotMatch(preview.snapshot.reportNotes.entries[0].text, /note@example.invalid/);
});

test("the larger reference cohort cannot silently change underneath a prepared report", async t => {
    const source = records(), { context } = await privateFixture(t, source);
    const state = await loadBoardState(context), controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, options(), { kind: "all", revision: state.revision });
    const changed = structuredClone(source);
    changed[1].toolCalls[0].apiResults[0].statusCode = 503;
    await replaceEvidence(context, () => ({ records: changed, importCoverage: state.importCoverage }));
    await assert.rejects(controller.confirm("owner", preview.previewId, true, timeContext, {
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false },
    }), /behind this report's counts changed/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("local Save writes and reopens original files without falsely attesting a text review", async t => {
    const source = records(), { context } = await privateFixture(t, source);
    const state = await loadBoardState(context), controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, options(), { kind: "all", revision: state.revision });
    await assert.rejects(controller.confirm("owner", preview.previewId, true, timeContext), /current preview/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const result = await controller.confirm("owner", preview.previewId, true, timeContext, {
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false },
    });
    assert.equal(result.bundle.privacyReview.reviewerConfirmed, false);
    assert.equal(result.bundle.privacyReview.localSave.method, "explicit-local-save");
    const after = await loadBoardState(context);
    assert.equal(after.exports.length, 1);
    const html = await readSavedArtifactFile(context, after, result.bundle.bundleId, "report", "html");
    assert.equal(html.bytes.toString(), preview.files["product-report.html"]);
    const manifest = await readSavedArtifactFile(context, after, result.bundle.bundleId, "report", "manifest");
    const json = await readSavedArtifactFile(context, after, result.bundle.bundleId, "report", "json");
    assert.equal(inspectSavedReportSnapshot({ manifestBytes: manifest.bytes, snapshotBytes: json.bytes,
        expectedManifestSha256: after.exports[0].manifestHash, expectedBundleId: result.bundle.bundleId }).status, "supported");
    const comparable = await loadSavedReportSource(context, after, result.bundle.bundleId);
    assert.equal(comparable.envelope.disclosureReviewed, false);
    assert.equal(comparable.envelope.localSaveConfirmed, true);
    await assert.rejects(controller.confirm("owner", preview.previewId, true, timeContext, {
        localSave: { ...preview.localSaveRequest, keepChatDetailsConfirmed: false },
    }), /Preview not found/);
    assert.deepEqual((await loadBoardState(context)).evidence, state.evidence);
});

test("keeping chat details requires its warning choice while legacy previews still require real review", async t => {
    const { context } = await privateFixture(t, records());
    const state = await loadBoardState(context), controller = createExportController(context);
    const selection = { kind: "all", revision: state.revision };
    const original = await controller.preview("owner", undefined, { ...options(), promptMode: "original" }, selection);
    await assert.rejects(controller.confirm("owner", original.previewId, true, timeContext, {
        localSave: { ...original.localSaveRequest, keepChatDetailsConfirmed: false },
    }), /chat details/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const saved = await controller.confirm("owner", original.previewId, true, timeContext, {
        localSave: { ...original.localSaveRequest, keepChatDetailsConfirmed: true },
    });
    assert.equal(saved.bundle.privacyReview.localSave.keepChatDetailsConfirmed, true);
    const fresh = await loadBoardState(context);
    const legacy = await controller.preview("legacy", undefined, { formats: ["html"] }, { kind: "all", revision: fresh.revision });
    await assert.rejects(controller.confirm("legacy", legacy.previewId, true), /disclosure review/);
});

test("fourteen-day reports use the existing time-zone-aware calendar contract", () => {
    assert.deepEqual(time.preset("14", "America/Los_Angeles", "2026-11-09T01:00:00Z"), { from: "2026-10-26", to: "2026-11-08" });
    assert.deepEqual(normalizeReportOptions({
        dateSelection: { range: "14", from: "2026-10-26", to: "2026-11-08" }, timeContext,
    }).dateSelection, { range: "14", from: "2026-10-26", to: "2026-11-08" });
    assert.throws(() => normalizeReportOptions({ reportNotes: [{ scenarioId: "x", text: "note", extra: true }] }), /report format/);
});

test("editing a prepared report never adds newly collected interactions to its frozen denominator", async t => {
    const source = records(), { context } = await privateFixture(t, source);
    const state = await loadBoardState(context), controller = createExportController(context);
    const first = await controller.preview("owner", undefined, options(), { kind: "all", revision: state.revision });
    const added = fixture("newly-added");
    added.capturedAt = "2026-11-04T20:00:00Z";
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    const changed = await controller.preview("owner", undefined, { ...options(), title: "Renamed report", promptMode: "original" },
        undefined, undefined, { rebuildFrom: first.previewId });
    assert.equal(changed.title, "Renamed report");
    assert.equal(changed.snapshot.reportPopulation.reference.length, 3);
    assert.equal(changed.snapshot.selectionScope.kind, "all");
    assert.deepEqual(changed.snapshot.reportPopulation, first.snapshot.reportPopulation);
    assert.notEqual(changed.previewId, first.previewId);
    await assert.rejects(controller.confirm("owner", first.previewId, true, timeContext, {
        localSave: { ...first.localSaveRequest, keepChatDetailsConfirmed: false },
    }), /Preview not found/);
    await assert.rejects(controller.preview("owner", undefined, {
        ...options(), reportFocus: { ...options().reportFocus, outcome: "completed" },
    }, undefined, undefined, { rebuildFrom: changed.previewId }), /activity choices changed/);
});

test("HTTP rebuild and local Save bind regenerated masked files in every format", { timeout: 60000 }, async t => {
    const { context } = await privateFixture(t, records());
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const origin = new URL(runtime.url).origin;
    let capability;
    async function post(route, body, status = 200) {
        const response = await fetch(origin + route, { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
            ...(capability ? { "X-Board-Capability": capability } : {}),
        }, body: JSON.stringify(body) });
        const result = await response.json();
        assert.equal(response.status, status, result.error);
        return result;
    }
    capability = (await post("/api/session", {})).capability;
    const state = await loadBoardState(context), formats = ["html", "pdf", "json", "markdown"];
    const first = await post("/api/preview", { options: { ...options(), promptMode: "original", formats },
        selection: { kind: "all", revision: state.revision } });
    assert.match(first.files["product-report.html"], /email@example.invalid/);
    const masked = await post("/api/preview", { rebuildFrom: first.previewId, options: {
        ...options(), title: "Recorded mailbox errors", formats,
        reportNotes: [{ scenarioId: first.records[0].scenarioId, text: "Expected a mailbox result. Contact note@example.invalid." }],
    } });
    assert.notEqual(masked.localSaveRequest.contentHash, first.localSaveRequest.contentHash);
    assert.deepEqual(masked.snapshot.reportPopulation, first.snapshot.reportPopulation);
    await post("/api/export", { previewId: masked.previewId, confirmed: true, timeContext,
        localSave: { ...first.localSaveRequest, keepChatDetailsConfirmed: false } }, 428);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const saved = await post("/api/export", { previewId: masked.previewId, confirmed: true, timeContext,
        localSave: { ...masked.localSaveRequest, keepChatDetailsConfirmed: false } });
    const current = await loadBoardState(context);
    assert.equal(current.exports.length, 1);
    for (const format of formats) {
        const file = await readSavedArtifactFile(context, current, saved.bundle.bundleId, "report", format);
        const text = format === "pdf" ? (await pdfDocumentText(file.bytes)).content : file.bytes.toString();
        assert.match(text, /Recorded mailbox errors/);
        assert.match(text, /Expected a mailbox result/);
        assert.match(text, /SYNTHETIC_FAILED_PROMPT/);
        assert.doesNotMatch(text, /email@example.invalid|note@example.invalid|SYNTHETIC_COMPLETED_PROMPT/);
        if (format === "json") assert.deepEqual(JSON.parse(text).reportPopulation, masked.snapshot.reportPopulation);
    }
    assert.equal(saved.bundle.privacyReview.reviewerConfirmed, false);
    assert.equal(saved.bundle.privacyReview.localSave.keepChatDetailsConfirmed, false);
});
