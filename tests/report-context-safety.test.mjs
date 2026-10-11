import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { projectReportContext } from "../lib/report-context.mjs";
import { normalizeReportOptions, projectReportCopy } from "../lib/prompt-projection.mjs";
import { inspectSavedReportSnapshot } from "../lib/saved-report-snapshot.mjs";

async function prepare(context, controller, id, options = {}) {
    const state = await loadBoardState(context);
    return controller.preview("context-owner", undefined, { recordedContext: true, formats: ["html", "json", "markdown"], ...options },
        { kind: "selected", revision: state.revision, scenarioIds: [id], promptAuthors: ["user"] });
}

test("context edits and omissions rebuild all real formats, freeze saved bytes and preserve analytical scopes", { timeout: 30000 }, async t => {
    const { context, records } = await reportContextFixture(t), controller = createExportController(context);
    const original = await loadBoardState(context);
    const first = await prepare(context, controller, records[1].scenarioId, { promptMode: "original" });
    const response = first.contextReview.find(copy => copy.kind === "response" && copy.original !== null);
    const earlier = first.contextReview.find(copy => copy.kind === "prompt");
    assert.match(response.text, /reply@example.invalid/);
    const originalEdited = await prepare(context, controller, records[1].scenarioId, { promptMode: "original",
        overrides: [{ key: response.key, text: "Original mode: reply@example.invalid password='original-context-secret'." }] });
    const originalCopy = originalEdited.snapshot.recordedContext.entries.find(entry => entry.key === response.key);
    assert.match(originalCopy.text, /reply@example.invalid/);
    assert.doesNotMatch(originalCopy.text, /original-context-secret/);
    const revised = await prepare(context, controller, records[1].scenarioId, { formats: ["html", "pdf", "json", "markdown"],
        manualTerms: ["ContextResearchCanary"], overrides: [{ key: earlier.key, omit: true },
            { key: response.key, text: "EDITED_REPLY ContextResearchCanary. Contact person@example.invalid. password='invented-secret'." }] });
    await assert.rejects(controller.review("context-owner", first.previewId, true), /not found/);
    const json = JSON.parse(revised.files["product-report.json"]), pdf = Buffer.from(revised.files["product-report.pdf"].data, "base64");
    const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
    const document = await task.promise;
    const pages = [];
    try {
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
            }
            pages.push(content.items.map(item => item.str ?? "").join(" "));
        }
    } finally { await task.destroy(); }
    for (const text of [JSON.stringify(json), revised.files["product-report.html"], revised.files["product-report.md"], pages.join("\n")]) {
        assert.match(text, /EDITED_REPLY/);
        assert.doesNotMatch(text, /person@example|invented-secret|ContextResearchCanary|Find five synthetic/);
        assert.match(text, /manual redaction/);
        assert.match(text, /credential removed/);
        assert.match(text, /omitted|Omitted/);
    }
    assert.equal(json.recordedContext.entries.find(entry => entry.key === earlier.key).omitted, true);
    const analyticalRecords = bundle => bundle.records.map(({ prompts, promptMode, ...record }) => record);
    assert.deepEqual(analyticalRecords(revised), analyticalRecords(first));
    assert.deepEqual(revised.snapshot.selectionScope, first.snapshot.selectionScope);
    await assert.rejects(controller.confirm("context-owner", revised.previewId, true), /disclosure review/);
    const approved = await controller.review("context-owner", revised.previewId, true);
    const saved = await controller.confirm("context-owner", revised.previewId, true);
    for (const [name, bytes] of Object.entries(approved.files)) {
        const expected = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes.data, "base64");
        assert.deepEqual(await readFile(saved.bundle.files[name]), expected);
        if (process.env.WIRE_REPORT_CONTEXT_PROOFS) {
            const directory = path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, "frozen");
            await mkdir(directory, { recursive: true });
            await writeFile(path.join(directory, name), expected);
        }
    }
    if (process.env.WIRE_REPORT_CONTEXT_PROOFS) await writeFile(path.join(process.env.WIRE_REPORT_CONTEXT_PROOFS, "frozen", "pdf-extraction.txt"), pages.join("\n"));
    const snapshotBytes = await readFile(saved.bundle.files["product-report.json"]);
    const manifestBytes = await readFile(saved.bundle.files["coverage-and-redaction-manifest.json"]);
    assert.equal(inspectSavedReportSnapshot({ manifestBytes, snapshotBytes, expectedManifestSha256: saved.bundle.manifestHash,
        expectedBundleId: saved.bundle.bundleId }).status, "supported");
    await replaceEvidence(context, () => ({ records: [], importCoverage: {} }));
    await updateBoardState(context, state => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", categories: [], revision: 2, revokedAt: "2026-10-01T00:00:00.000Z" };
    });
    assert.deepEqual(await readFile(saved.bundle.files["product-report.json"]), snapshotBytes);
    assert.deepEqual(await readFile(saved.bundle.files["coverage-and-redaction-manifest.json"]), manifestBytes);
    assert.equal(original.exports.length, 0);
});

test("missing and revoked replies are explicit gaps; none and author exclusion never open malformed retained payloads", async t => {
    const { context, records } = await reportContextFixture(t), controller = createExportController(context);
    const state = await loadBoardState(context), capture = state.personalEvaluation.captures[0];
    const file = path.join(context.dataDir, "assessment-evidence", capture.payloadFile);
    await writeFile(file, "MALFORMED_PAYLOAD_MUST_NOT_BE_READ");
    const none = await prepare(context, controller, records[1].scenarioId, { promptMode: "none" });
    assert.equal(Object.hasOwn(none.snapshot, "recordedContext"), false);
    assert.equal(none.records.every(record => record.prompts.every(prompt => prompt.text === null)), true);
    await assert.rejects(prepare(context, controller, records[1].scenarioId), /capture-integrity-failed/);
    await replaceEvidence(context, () => ({ records: state.evidence.map(record => record.scenarioId === records[1].scenarioId
        ? { ...record, userPrompt: { ...record.userPrompt, authorship: { actor: "agent", basis: "source-agent" } } } : record), importCoverage: {} }));
    const excluded = await prepare(context, controller, records[0].scenarioId);
    assert.match(JSON.stringify(excluded.snapshot.recordedContext), /excluded by originating prompt author/);
    assert.doesNotMatch(JSON.stringify(excluded), /MALFORMED_PAYLOAD|Here are three synthetic|Three synthetic documents/);
    await replaceEvidence(context, () => ({ records: state.evidence, importCoverage: {} }));
    await unlink(file);
    const missing = await prepare(context, controller, records[1].scenarioId);
    assert.match(JSON.stringify(missing.snapshot.recordedContext), /retained reply file is missing/i);
    assert.equal(missing.snapshot.recordedContext.entries.filter(entry => entry.kind === "response").every(entry => entry.text === null), true);
    await updateBoardState(context, current => {
        current.personalEvaluation.consent = { ...current.personalEvaluation.consent, state: "revoked", categories: [], revision: 2, revokedAt: "2026-10-01T00:00:00.000Z" };
    });
    const revoked = await prepare(context, controller, records[1].scenarioId);
    assert.match(JSON.stringify(revoked.snapshot.recordedContext), /missing or no longer authorized/);
});

test("context-only source, linkage, deletion and permission changes invalidate reviewed copies before save", async t => {
    const changes = {
        text: async (context, state, records) => replaceEvidence(context, () => ({ records: state.evidence.map(record =>
            record.scenarioId === records[0].scenarioId ? { ...record, userPrompt: { ...record.userPrompt, text: "Changed earlier request" } } : record), importCoverage: {} })),
        linkage: async (context, state, records) => replaceEvidence(context, () => ({ records: state.evidence.map(record =>
            record.scenarioId === records[0].scenarioId ? { ...record, followUpPrompts: [] } : record), importCoverage: {} })),
        deletion: async (context, state, records) => replaceEvidence(context, () => ({ records: state.evidence.filter(record =>
            record.scenarioId !== records[0].scenarioId), importCoverage: {} })),
        permission: async context => updateBoardState(context, state => { state.personalEvaluation.source.sourceConfigRevision++; }),
        captureMembership: async context => updateBoardState(context, state => { state.personalEvaluation.captures[0].observation.captureContext.sourceConfigRevision++; }),
        payload: async (context, state) => unlink(path.join(context.dataDir, "assessment-evidence", state.personalEvaluation.captures[0].payloadFile)),
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const { context, records } = await reportContextFixture(t), controller = createExportController(context);
        const preview = await prepare(context, controller, records[1].scenarioId);
        await controller.review("context-owner", preview.previewId, true);
        const before = await loadBoardState(context);
        await change(context, before, records);
        await assert.rejects(controller.review("context-owner", preview.previewId, true), /context|authority/i);
        await assert.rejects(controller.confirm("context-owner", preview.previewId, true), /context|authority/i);
        assert.equal((await loadBoardState(context)).exports.length, 0);
    });
});

test("copy budgets use aggregate UTF-8 source and projected bytes with deduplicated keys", () => {
    const options = normalizeReportOptions({ recordedContext: true });
    const ref = "scenario-" + "a".repeat(16);
    const entry = (key, text) => ({ key, scenarioRef: ref, eventRef: null, observationRef: null, kind: "prompt",
        at: null, status: "full", original: text, label: "Recorded prompt", finality: null,
        authorship: { actor: "unknown", basis: "legacy-missing" }, originKind: "unverified" });
    const collected = entries => ({ entries, anchors: [{ groups: [{ scenarioRef: ref }], authorExcludedGroups: 0 }] });
    const selected = Array.from({ length: 2999 }, (_, index) => projectReportCopy(entry(`selected-${index}`, "x"), options));
    const context = entry(`${ref}:context-origin`, "x");
    assert.equal(projectReportContext(collected([context]), options, selected).review.length, 1);
    assert.throws(() => projectReportContext(collected([context]), options, [...selected, projectReportCopy(entry("extra", "x"), options)]), /3000-copy/);
    const nearLimit = projectReportCopy(entry("selected", "\u00e9".repeat((4 * 1024 * 1024 - 2) / 2)), options);
    const twoBytes = entry(`${ref}:context-origin`, "\u00e9");
    assert.equal(projectReportContext(collected([twoBytes]), options, [nearLimit]).frozen.coverage.sourceBytes, 2);
    assert.throws(() => projectReportContext(collected([{ ...twoBytes, original: "\u00e9x" }]), options, [nearLimit]), /UTF-8 text budget/);
    const shared = entry(`${ref}:origin`, "\u00e9".repeat(2 * 1024 * 1024));
    assert.equal(projectReportContext(collected([shared]), options, [projectReportCopy(shared, options)]).review.length, 0);
    assert.throws(() => projectReportContext(collected([twoBytes, twoBytes]), options, []), /duplicate identities/);
    assert.throws(() => projectReportContext(collected([twoBytes]), options, [projectReportCopy({ ...twoBytes, original: "Conflicting copy" }, options)]), /conflict/);
});

test("context changed during rendering cannot escape the post-render dependency check", async t => {
    const { context, records } = await reportContextFixture(t);
    const controller = createExportController(context, undefined, async () => {
        const state = await loadBoardState(context);
        await replaceEvidence(context, () => ({ records: state.evidence.filter(record => record.scenarioId !== records[0].scenarioId), importCoverage: {} }));
        return Buffer.from("%PDF-fixture-for-post-render-guard");
    });
    await assert.rejects(prepare(context, controller, records[1].scenarioId, { formats: ["pdf"] }), /context changed/i);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});
