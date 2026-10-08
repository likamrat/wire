import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { assertProjectedBundle } from "../lib/privacy.mjs";
import { normalizeReportOptions } from "../lib/prompt-projection.mjs";
import { loadBoardState, moveCard } from "../lib/store.mjs";
import { time } from "../lib/time.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

const local = time.normalize({ timeZone: "America/Los_Angeles", locale: "en-GB" });
const utc = time.normalize({ timeZone: "UTC", locale: "en-US" });
const options = {
    timeContext: local, dateSelection: { range: "custom", from: "2026-03-08", to: "2026-03-08" },
    formats: ["html", "pdf", "json", "markdown"],
};
const raw = "Original wording uses 2026-03-08T08:00:00Z. Do not shift it.";

for (const promptMode of ["none", "masked", "original"]) test(`${promptMode}: four formats freeze viewer time and retain timestamp privacy`, { timeout: 120000 }, async () => {
    const record = fixture();
    record.userPrompt.text = raw;
    record.userPrompt.sourceTimestamp = "2026-01-02T03:04:05Z";
    record.toolCalls[0].startedAt = "2026-01-02T03:05:06Z";
    const before = structuredClone(record);
    const bundle = await buildSanitizedBundle([record], "a".repeat(64), { ...options, promptMode });
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    assert.deepEqual(snapshot.timeContext, local);
    assert.equal(snapshot.preparedAtDisplay, time.formatTime(snapshot.preparedAt, local));
    assert.match(snapshot.preparedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.deepEqual(snapshot.dateRange, { from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z", toExclusive: true });
    for (const key of ["timeContext", "dateSelection", "dateRange", "preparedAtDisplay"]) assert.deepEqual(manifest[key], snapshot[key]);
    const task = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    let pdf;
    try {
        const doc = await task.promise, pages = [];
        for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map(x => x.str ?? "").join(" "));
        pdf = pages.join("\n");
    } finally { await task.destroy(); }
    for (const text of [bundle.previewHtml, bundle.files["product-report.md"], pdf]) {
        const folded = text.replace(/\s+/g, " ");
        assert.ok(folded.includes(snapshot.preparedAtDisplay.replace(/\s+/g, " ")));
        assert.ok(folded.includes("America/Los_Angeles"));
        assert.ok(folded.includes("en-GB"));
        assert.ok(folded.includes("8 Mar 2026"));
    }
    for (const text of [...Object.values(bundle.files).filter(x => typeof x === "string"), pdf]) {
        assert.doesNotMatch(text, /2026-01-02T03:04:05Z|2026-01-02T03:05:06Z/);
        assert.equal(text.includes(raw), promptMode !== "none" && text !== bundle.files["coverage-and-redaction-manifest.json"]);
    }
    assert.deepEqual(record, before);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
});

test("zone/locale mismatch consumes stale review without files; saved bundles stay immutable", { timeout: 120000 }, async t => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const controller = createExportController(context);
    const baseline = await loadBoardState(context);
    const source = await readFile(path.join(context.dataDir, "private-evidence", baseline.evidenceFile));
    const preview = await controller.preview("synthetic", undefined, options);
    const reviewed = await controller.review("synthetic", preview.previewId, true, local);
    await assert.rejects(controller.confirm("synthetic", preview.previewId, true, utc), /timezone or locale changed/);
    await assert.rejects(controller.confirm("synthetic", preview.previewId, true, local), /not found/);
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
    assert.equal((await loadBoardState(context)).revision, baseline.revision);
    const replacement = await controller.preview("synthetic", undefined, options);
    const frozen = await controller.review("synthetic", replacement.previewId, true, local);
    const result = await controller.confirm("synthetic", frozen.previewId, true, local);
    const files = await Promise.all(Object.entries(result.bundle.files).map(async ([name, file]) => [file, await readFile(file), name]));
    for (const [, bytes, name] of files) assert.deepEqual(bytes, typeof frozen.files[name] === "string" ? Buffer.from(frozen.files[name]) : Buffer.from(frozen.files[name].data, "base64"));
    assert.deepEqual(result.bundle.timeContext, local);
    await moveCard(context, "test-scenario", "ready_to_export");
    await controller.preview("synthetic", undefined, { ...options, timeContext: utc });
    for (const [file, bytes] of files) assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", baseline.evidenceFile)), source);
    assert.deepEqual(reviewed.timeContext, local);
});

test("report context validation and integrity reject forged metadata", async () => {
    for (const patch of [
        { timeContext: { timeZone: "-07:00", locale: "en-US" } },
        { timeContext: { timeZone: "UTC", locale: "not_a_locale" } },
        { dateSelection: { range: "custom", from: "2026-02-30" } },
        { dateSelection: { range: "capture", from: "2026-01-01" } },
    ]) assert.throws(() => normalizeReportOptions(patch), e => e.status === 422);
    const bundle = await buildSanitizedBundle([fixture()], "a".repeat(64), { timeContext: local });
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    manifest.timeContext = utc;
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest);
    assert.throws(() => assertProjectedBundle(bundle), /time context changed/);
});
