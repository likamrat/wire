import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, moveCard, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t) {
    const earlier = fixture("earlier"), later = fixture("later");
    later.toolCalls[0].toolSucceeded = false;
    later.toolCalls[0].reportedOutcome = "failed";
    const { context } = await privateFixture(t, [earlier, later]);
    await moveCard(context, "earlier", "ready_to_export");
    await moveCard(context, "later", "ready_to_export");
    const controller = createExportController(context);
    async function save(id, formats) {
        const preview = await controller.preview("panel", [id], { promptMode: "none", formats });
        await controller.review("panel", preview.previewId, true);
        return (await controller.confirm("panel", preview.previewId, true)).bundle;
    }
    return { context, controller, earlier: await save("earlier", ["html"]), later: await save("later", ["markdown"]) };
}

test("format-independent facts support comparison without saved source JSON", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const inspected = await controller.inspectComparison("panel", earlier.bundleId, later.bundleId);
    assert.equal(inspected.comparison.toolComparison.raw.baseline.success, 1);
    assert.equal(inspected.comparison.toolComparison.raw.later.failure, 1);
    assert.ok(inspected.comparison.metrics.some(metric => metric.metric === "accuracy" && metric.baseline?.value === null));
    const before = await readdir(path.join(context.dataDir, "exports"));
    const preview = await controller.previewComparison("panel", earlier.bundleId, later.bundleId, { formats: ["html", "json", "markdown"] });
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), before);
    assert.equal(preview.kind, "comparison");
    assert.equal(preview.privacy.reviewerConfirmed, false);
    for (const name of ["comparison-report.html", "comparison-report.md"]) {
        assert.match(preview.files[name], /Partial: 0/);
        assert.match(preview.files[name], /Unknown: 0/);
    }
    await assert.rejects(controller.confirmComparison("panel", preview.previewId, true), /disclosure review/);
    const reviewed = await controller.reviewComparison("panel", preview.previewId, true);
    assert.equal(reviewed.privacy.reviewerConfirmed, true);
    const saved = await controller.confirmComparison("panel", preview.previewId, true);
    assert.equal(saved.bundle.kind, "comparison");
    assert.deepEqual(saved.bundle.sourceReports.map(source => source.bundleId), [earlier.bundleId, later.bundleId]);
    for (const [name, content] of Object.entries(reviewed.files)) assert.equal(await readFile(saved.bundle.files[name], "utf8"), content);
    const opened = await controller.openComparison("panel", saved.bundle.bundleId);
    assert.deepEqual(opened.comparison, inspected.comparison);
    assert.ok(opened.sources.every(source => source.available));
    const text = await readFile(saved.bundle.files["comparison-report.json"], "utf8");
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP|email@example/);
});

test("deleted source report invalidates unsaved approval but saved comparisons retain their bytes", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const preview = await controller.previewComparison("panel", earlier.bundleId, later.bundleId);
    await controller.reviewComparison("panel", preview.previewId, true);
    const saved = (await controller.confirmComparison("panel", preview.previewId, true)).bundle;
    const hashes = await Promise.all(Object.values(saved.files).map(async file => hash(await readFile(file))));
    const stale = await controller.previewComparison("panel", earlier.bundleId, later.bundleId);
    await controller.reviewComparison("panel", stale.previewId, true);
    await updateBoardState(context, state => { state.exports = state.exports.filter(entry => entry.bundleId !== earlier.bundleId); });
    await assert.rejects(controller.confirmComparison("panel", stale.previewId, true), /no longer available/);
    const opened = await controller.openComparison("panel", saved.bundleId);
    assert.equal(opened.sources[0].available, false);
    assert.equal(opened.sources[1].available, true);
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async file => hash(await readFile(file)))), hashes);
});

test("source deletion or consent change rejects stale comparison review without erasing saved sources", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const preview = await controller.previewComparison("panel", earlier.bundleId, later.bundleId);
    await updateBoardState(context, state => {
        state.personalEvaluation = defaultPersonalEvaluation();
        state.personalEvaluation.consent.revision = 1;
    });
    await assert.rejects(controller.reviewComparison("panel", preview.previewId, true), /data or permission change/);
    assert.equal((await loadBoardState(context)).exports.length, 2);
    controller.invalidateDerived();
    await assert.rejects(controller.reviewComparison("panel", preview.previewId, true), /no longer available/);
});

test("saved source reports can be compared after collected evidence is removed", async t => {
    const { context, controller, earlier, later } = await setup(t);
    await replaceEvidence(context, () => ({ records: [], importCoverage: {} }));
    const result = await controller.inspectComparison("panel", earlier.bundleId, later.bundleId);
    assert.equal(result.comparison.toolComparison.raw.baseline.count, 1);
    assert.equal(result.comparison.toolComparison.raw.later.count, 1);
    assert.equal((await loadBoardState(context)).exports.length, 2);
});

test("unrelated collected activity does not invalidate an unchanged selected report", async t => {
    const { context, controller } = await setup(t);
    const preview = await controller.preview("selected", ["earlier"], { promptMode: "none", formats: ["html"] });
    await controller.review("selected", preview.previewId, true);
    await replaceEvidence(context, records => ({
        records: records.map(record => record.scenarioId === "later" ? {
            ...record, toolCalls: record.toolCalls.map(call => ({ ...call, toolSucceeded: true, reportedOutcome: "succeeded" })),
        } : record),
        importCoverage: {},
    }));
    const result = await controller.confirm("selected", preview.previewId, true);
    assert.equal(result.bundle.kind, "report");
});

test("all comparison formats share reviewed frozen facts and the real PDF remains searchable", { timeout: 60000 }, async t => {
    const { context, controller, earlier, later } = await setup(t);
    const preview = await controller.previewComparison("all-formats", earlier.bundleId, later.bundleId, { formats: ["html", "pdf", "json", "markdown"] });
    const reviewed = await controller.reviewComparison("all-formats", preview.previewId, true);
    const saved = (await controller.confirmComparison("all-formats", preview.previewId, true)).bundle;
    for (const [name, value] of Object.entries(reviewed.files)) {
        const expected = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.data, "base64");
        assert.deepEqual(await readFile(saved.files[name]), expected);
    }
    const bytes = await readFile(saved.files["comparison-report.pdf"]);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
        const doc = await task.promise, text = [];
        for (let n = 1; n <= doc.numPages; n++) text.push((await (await doc.getPage(n)).getTextContent()).items.map(item => item.str ?? "").join(""));
        assert.match(text.join("\n"), /WIRE/);
        assert.match(text.join("\n"), /Accuracy/);
        assert.match(text.join("\n"), /Not assessed/);
    } finally { await task.destroy(); }
    assert.equal((await loadBoardState(context)).exports.length, 3);
});
