import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, moveCard, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readSavedArtifactFile, readSavedComparison, loadSavedReportSource } from "../lib/report-artifacts.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

test("actual saved-report traffic-mix matrix refuses a false improvement narrative", async t => {
    function pattern(name, total, success, endpoint) {
        return matrixRecords(name, Array.from({ length: total }, (_, index) => index < success ? "success" : "failure")).map(record => ({
            ...record, toolCalls: record.toolCalls.map(call => ({ ...call, requestedApiPath: endpoint, requestArgs: { entityUrls: [endpoint] } })),
        }));
    }
    const baseline = [...pattern("before-easy", 10, 9, "/me/messages"), ...pattern("before-hard", 10, 5, "/me/calendarView")];
    const later = [...pattern("after-easy", 90, 81, "/me/messages"), ...pattern("after-hard", 10, 5, "/me/calendarView")];
    const { context } = await privateFixture(t, [...baseline, ...later]);
    const controller = createExportController(context), bundles = [];
    for (const records of [baseline, later]) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("matrix", undefined, { promptMode: "none", formats: ["json"] },
            { kind: "selected", revision: state.revision, scenarioIds: records.map(record => record.scenarioId) });
        await controller.review("matrix", preview.previewId, true);
        bundles.push((await controller.confirm("matrix", preview.previewId, true)).bundle);
    }
    const pair = await controller.inspectComparison("matrix", bundles[0].bundleId, bundles[1].bundleId);
    assert.equal(pair.comparison.toolComparison.raw.baseline.successRate.percent, 70);
    assert.equal(pair.comparison.toolComparison.raw.later.successRate.percent, 86);
    assert.ok(pair.comparison.toolComparison.patterns.length > 0);
    assert.ok(pair.comparison.toolComparison.patterns.every(item => item.change.success === 0));
    assert.equal(pair.comparison.toolComparison.matched.fixedBaselineMix.change.success, 0);
    assert.match(pair.comparison.narrative.heading, /pattern rates did not/);
    assert.equal(pair.comparison.narrative.tone, "neutral");
    const comparison = await controller.previewComparison("matrix", bundles[0].bundleId, bundles[1].bundleId, { formats: ["html", "json", "markdown"] });
    for (const name of ["comparison-report.html", "comparison-report.md"]) {
        assert.match(comparison.files[name], /pattern rates did not/);
        assert.doesNotMatch(comparison.files[name], /team improved|fix caused|quality improved/);
    }
});

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

for (const source of ["earlier", "later"]) for (const stage of ["inspect", "prepare", "review", "save"]) {
    test(`comparison ${stage} rejects a declared ${source} title mismatch without writing`, async t => {
        const setupResult = await setup(t), { context, controller, earlier, later } = setupResult;
        let preview;
        if (stage === "review" || stage === "save") {
            preview = await controller.previewComparison("title-binding", earlier.bundleId, later.bundleId, { formats: ["html"] });
            if (stage === "save") await controller.reviewComparison("title-binding", preview.previewId, true);
        }
        await updateBoardState(context, state => {
            state.exports.find(entry => entry.bundleId === setupResult[source].bundleId).title = "Not the declared source title";
        });
        const state = await loadBoardState(context), before = JSON.stringify(state);
        const files = await Promise.all([earlier, later].flatMap(entry => Object.values(entry.files)).map(async file => [file, await readFile(file)]));
        await assert.rejects(loadSavedReportSource(context, state, setupResult[source].bundleId), /title differs/);
        const action = stage === "inspect" ? () => controller.inspectComparison("title-binding", earlier.bundleId, later.bundleId)
            : stage === "prepare" ? () => controller.previewComparison("title-binding", earlier.bundleId, later.bundleId, { formats: ["html"] })
                : stage === "review" ? () => controller.reviewComparison("title-binding", preview.previewId, true)
                    : () => controller.confirmComparison("title-binding", preview.previewId, true);
        await assert.rejects(action, /title differs|changed/i);
        assert.equal(JSON.stringify(await loadBoardState(context)), before);
        for (const [file, bytes] of files) assert.deepEqual(await readFile(file), bytes);
    });
}

test("comparison titles bind every new format and verified canonical-title carrier", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const title = "Calendar request comparison";
    const originalFiles = [...Object.values(earlier.files), ...Object.values(later.files)];
    const originals = await Promise.all(originalFiles.map(async file => hash(await readFile(file))));
    const preview = await controller.previewComparison("named-comparison", earlier.bundleId, later.bundleId, {
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
    const reviewed = await controller.reviewComparison("named-comparison", preview.previewId, true);
    const saved = (await controller.confirmComparison("named-comparison", preview.previewId, true)).bundle;
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
    const preview = await controller.previewComparison("legacy-title-carrier", earlier.bundleId, later.bundleId, {
        formats: ["html", "pdf", "json", "markdown"],
    });
    await controller.reviewComparison("legacy-title-carrier", preview.previewId, true);
    const comparison = (await controller.confirmComparison("legacy-title-carrier", preview.previewId, true)).bundle;
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
    assert.ok(await controller.inspectComparison("undeclared-source-title", earlier.bundleId, later.bundleId),
        "An indexed legacy label does not become a manifest-declared title binding");
});

test("format-independent facts support comparison without saved source JSON", async t => {
    const { context, controller, earlier, later } = await setup(t);
    const inspected = await controller.inspectComparison("panel", earlier.bundleId, later.bundleId);
    assert.equal(inspected.comparison.toolComparison.raw.baseline.success, 1);
    assert.equal(inspected.comparison.toolComparison.raw.later.failure, 1);
    assert.equal(inspected.comparison.metricProjectionVersion, 4);
    assert.equal(inspected.comparison.metrics.some(metric => metric.metric === "accuracy"), false,
        "No retired automatic-quality placeholder replaces missing personal feedback.");
    const before = await readdir(path.join(context.dataDir, "exports"));
    const preview = await controller.previewComparison("panel", earlier.bundleId, later.bundleId, { formats: ["html", "json", "markdown"] });
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), before);
    assert.equal(preview.kind, "comparison");
    assert.equal(preview.privacy.reviewerConfirmed, false);
    for (const name of ["comparison-report.html", "comparison-report.md"]) {
        assert.doesNotMatch(preview.files[name], /Partial: 0|Unknown: 0/, "Zero-only outcomes do not clutter human output");
    }
    assert.equal(preview.snapshot.comparison.toolComparison.raw.baseline.partial, 0);
    assert.equal(preview.snapshot.comparison.toolComparison.raw.later.unknown, 0);
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
