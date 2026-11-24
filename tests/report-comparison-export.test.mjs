import { historicalComparison } from "./historical-comparison-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, moveCard, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readSavedArtifactFile, readSavedComparison } from "../lib/report-artifacts.mjs";

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

test("comparison titles bind every new format and verified canonical-title carrier", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const title = "Calendar request comparison";
    const originalFiles = [...Object.values(earlier.files), ...Object.values(later.files)];
    const originals = await Promise.all(originalFiles.map(async file => hash(await readFile(file))));
    const preview = await historicalComparison(context, earlier.bundleId, later.bundleId, {
        title, formats: ["html", "pdf", "json", "markdown"],
    });
    assert.equal(preview.title, title);
    assert.equal(preview.snapshot.title, title);
    assert.equal(JSON.parse(preview.files["coverage-and-redaction-manifest.json"]).title, title);
    assert.ok(preview.previewHtml.includes(`<title>WIRE - ${title}</title>`));
    assert.ok(preview.files["comparison-report.md"].startsWith("# " + title + "\n"));
    const document = getDocument({ data: new Uint8Array(Buffer.from(preview.files["comparison-report.pdf"].data, "base64")), useSystemFonts: false });
    try {
        const pdf = await document.promise;
        const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str || "").join(" ");
        assert.ok(text.includes(title));
    } finally { await document.destroy(); }
    const reviewed = preview;
    const saved = preview.bundle;
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
        assert.match(text.join("\n"), /Recorded tool completion/);
        assert.doesNotMatch(text.join("\n"), /Answer correctness|Not checked automatically|AI results/);
    } finally { await task.destroy(); }
    assert.equal(saved.title, title);
    const state = await loadBoardState(context);
    assert.equal(state.exports.length, 3);
    for (const format of ["html", "pdf", "json", "markdown", "manifest"]) {
        assert.equal((await readSavedArtifactFile(context, state, saved.bundleId, "comparison", format)).canonicalTitle, title);
    }
    assert.equal((await readSavedComparison(context, state, saved.bundleId)).canonicalTitle, title);
    const changed = structuredClone(state);
    changed.exports.find(entry => entry.bundleId === saved.bundleId).title = "Another comparison";
    await assert.rejects(readSavedArtifactFile(context, changed, saved.bundleId, "comparison", "html"), /title differs/);
    await assert.rejects(readSavedComparison(context, changed, saved.bundleId), /title differs/);
    assert.deepEqual(await Promise.all(originalFiles.map(async file => hash(await readFile(file)))), originals);
    const jsonFile = saved.files["comparison-report.json"], manifestFile = saved.files["coverage-and-redaction-manifest.json"];
    const mismatched = JSON.parse(await readFile(jsonFile, "utf8"));
    mismatched.title = "Different document title";
    const text = JSON.stringify(mismatched, null, 2) + "\n";
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.files["comparison-report.json"] = { bytes: Buffer.byteLength(text), sha256: hash(text) };
    manifest.snapshotHash = hash(JSON.stringify(mismatched));
    const metadata = JSON.stringify(manifest);
    await writeFile(jsonFile, text); await writeFile(manifestFile, metadata);
    const conflicting = structuredClone(state);
    conflicting.exports.find(entry => entry.bundleId === saved.bundleId).manifestHash = hash(metadata);
    await assert.rejects(readSavedArtifactFile(context, conflicting, saved.bundleId, "comparison", "json"), /title differs/);
});

test("canonical title stays absent for verified older files even when indexed or document titles exist", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const { bundle: comparison } = await historicalComparison(context, earlier.bundleId, later.bundleId, {
        formats: ["html", "pdf", "json", "markdown"],
    });
    for (const entry of [earlier, comparison]) {
        const name = entry.kind === "comparison" ? "comparison-report.json" : "product-report.json";
        const manifestFile = entry.files["coverage-and-redaction-manifest.json"];
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        delete manifest.title;
        if (entry.files[name]) {
            const snapshot = JSON.parse(await readFile(entry.files[name], "utf8"));
            delete snapshot.title;
            const text = JSON.stringify(snapshot, null, 2) + "\n";
            await writeFile(entry.files[name], text);
            manifest.files[name] = { bytes: Buffer.byteLength(text), sha256: hash(text) };
            manifest.snapshotHash = hash(JSON.stringify(snapshot));
        }
        const bytes = JSON.stringify(manifest);
        await writeFile(manifestFile, bytes);
        await updateBoardState(context, state => {
            const indexed = state.exports.find(value => value.bundleId === entry.bundleId);
            indexed.title = "Indexed label, not a manifest-declared title";
            indexed.manifestHash = hash(bytes);
            indexed.snapshotHash = manifest.snapshotHash;
        });
    }
    const state = await loadBoardState(context);
    for (const entry of [earlier, comparison]) for (const format of entry.formats) {
        const value = await readSavedArtifactFile(context, state, entry.bundleId, entry.kind, format);
        assert.equal(Object.hasOwn(value, "canonicalTitle"), false);
        assert.equal(value.artifact.title, "Indexed label, not a manifest-declared title");
    }
    assert.equal(Object.hasOwn(await readSavedComparison(context, state, comparison.bundleId), "canonicalTitle"), false);
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
