import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, rename, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedArtifactFile, readSavedComparisonFile, reportHash, artifactIndexFingerprint } from "../lib/report-artifacts.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";

const formats = ["html", "json", "markdown", "pdf"];

test("artifact-file rejects missing private state without initialization or publication", async t => {
    const cleanup = [];
    const { context, root } = await privateFixture({ after: action => cleanup.push(action) });
    let publications = 0;
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false, onCommitted: () => { publications++; } },
    });
    const unavailable = path.join(root, "unavailable-fixture-data");
    let moved = false;
    t.after(async () => {
        try {
            if (moved) {
                try { await rename(context.dataDir, path.join(root, "unexpected-read-state")); }
                catch (error) { if (error.code !== "ENOENT") throw error; }
                await rename(unavailable, context.dataDir);
            }
            await runtime.close();
        }
        finally { for (const action of cleanup) await action(); }
    });
    const origin = new URL(runtime.url).origin;
    const session = await fetch(origin + "/api/session", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(session.status, 200, "The owned fixture server is already running before state becomes unavailable");
    const { capability } = await session.json();
    await rename(context.dataDir, unavailable);
    moved = true;
    await assert.rejects(lstat(context.dataDir), { code: "ENOENT" });
    const before = (await readdir(root, { recursive: true })).sort(), publishedBefore = publications;
    const response = await fetch(origin + "/api/artifact-file", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability },
        body: JSON.stringify({ bundleId: "export-00000000-0000-4000-8000-000000000001", kind: "comparison", format: "html" }) });
    const result = await response.json();
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, "Failed reads must not recreate directories or publish replacement state");
    await assert.rejects(lstat(context.dataDir), { code: "ENOENT" });
    assert.equal(publications, publishedBefore);
    assert.equal(response.status, 404);
    assert.match(result.error, /Existing private state is unavailable.*Read-only access did not initialize it/);
    assert.equal(Object.hasOwn(result, "data"), false);
    assert.equal(Object.hasOwn(result, "artifact"), false);
});

async function setup(t) {
    const { context } = await privateFixture(t, [fixture("earlier"), fixture("later")]);
    const controller = createExportController(context), sources = [];
    for (const id of ["earlier", "later"]) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("fixture", undefined, { promptMode: "none", formats },
            { kind: "selected", revision: state.revision, scenarioIds: [id] });
        await controller.review("fixture", preview.previewId, true);
        sources.push((await controller.confirm("fixture", preview.previewId, true)).bundle);
    }
    const preview = await controller.previewComparison("fixture", sources[0].bundleId, sources[1].bundleId, { formats });
    await controller.reviewComparison("fixture", preview.previewId, true);
    const comparison = (await controller.confirmComparison("fixture", preview.previewId, true)).bundle;
    return { context, controller, sources, comparison };
}

test("verified artifact files retain exact bytes and identity for every ordinary/comparison format and manifest", { timeout: 30000 }, async t => {
    const { context, controller, sources, comparison } = await setup(t);
    const state = await loadBoardState(context), before = JSON.stringify(state);
    for (const artifact of [sources[0], comparison]) for (const format of [...formats, "manifest"]) {
        const document = await readSavedArtifactFile(context, state, artifact.bundleId, artifact.kind, format);
        const bytes = await readFile(artifact.files[document.name]);
        assert.deepEqual(document.bytes, bytes);
        assert.equal(document.sha256, reportHash(bytes));
        assert.equal(document.manifestHash, artifact.manifestHash);
        assert.equal(document.indexFingerprint, artifactIndexFingerprint(state.exports.find(item => item.bundleId === artifact.bundleId)));
    }
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    const reportManifestPath = sources[0].files["coverage-and-redaction-manifest.json"];
    const reportManifestBytes = await readFile(reportManifestPath), wrongKind = JSON.parse(reportManifestBytes);
    wrongKind.kind = "unsupported";
    const wrongBytes = JSON.stringify(wrongKind), wrongState = structuredClone(state);
    wrongState.exports.find(entry => entry.bundleId === sources[0].bundleId).manifestHash = reportHash(wrongBytes);
    await writeFile(reportManifestPath, wrongBytes);
    await assert.rejects(readSavedArtifactFile(context, wrongState, sources[0].bundleId, "report", "html"), /kind differs/);
    await writeFile(reportManifestPath, reportManifestBytes);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const origin = new URL(runtime.url).origin;
    const post = (route, body, capability) => fetch(origin + route, { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body) });
    const input = { bundleId: comparison.bundleId, kind: "comparison", format: "html" };
    assert.equal((await post("/api/artifact-file", input)).status, 403);
    const { capability } = await (await post("/api/session", {})).json();
    for (const format of [...formats, "manifest"]) {
        const response = await post("/api/artifact-file", { ...input, format }, capability);
        assert.equal(response.status, 200);
        const value = await response.json();
        assert.equal(value.encoding, "base64");
        assert.deepEqual(Buffer.from(value.data, "base64"), await readFile(comparison.files[value.name]));
        assert.equal(value.manifestHash, comparison.manifestHash);
        assert.equal(value.artifact.bundleId, comparison.bundleId);
        assert.equal(Object.hasOwn(value, "bytes"), false);
    }
    for (const change of [{ kind: "period-comparison" }, { kind: "report" }, { format: "../comparison-report.html" }, { name: "comparison-report.html" }]) {
        const response = await post("/api/artifact-file", { ...input, ...change }, capability);
        assert.ok([400, 404, 422].includes(response.status), `${JSON.stringify(change)}: ${response.status}`);
    }
});

test("comparison file reads reject tampering, wrong inventory, missing files and unregistered disclosure without fallback", { timeout: 30000 }, async t => {
    const { context, comparison } = await setup(t);
    const state = await loadBoardState(context), name = "comparison-report.html";
    const original = await readFile(comparison.files[name]);
    await writeFile(comparison.files[name], Buffer.concat([original, Buffer.from("\nnot reviewed")]));
    await assert.rejects(readSavedComparisonFile(context, state, comparison.bundleId, "html"), /file changed/);
    await writeFile(comparison.files[name], original);
    const manifestName = "coverage-and-redaction-manifest.json", manifestBytes = await readFile(comparison.files[manifestName]);
    const manifest = JSON.parse(manifestBytes);
    manifest.formats = [[...manifest.formats].sort().join(",")];
    const invalidManifest = JSON.stringify(manifest), invalidState = structuredClone(state);
    invalidState.exports.find(entry => entry.bundleId === comparison.bundleId).manifestHash = reportHash(invalidManifest);
    await writeFile(comparison.files[manifestName], invalidManifest);
    await assert.rejects(readSavedComparisonFile(context, invalidState, comparison.bundleId, "html"), /format inventory/);
    await writeFile(comparison.files[manifestName], manifestBytes);
    for (const mutate of [
        entry => { entry.privacyReview.reviewerConfirmed = false; },
        entry => { entry.formats = ["html"]; },
        entry => { entry.files["invented.txt"] = entry.files[name]; },
        entry => { entry.promptMode = "original"; },
        entry => { entry.manifestHash = "0".repeat(64); },
    ]) {
        const changed = structuredClone(state);
        mutate(changed.exports.find(item => item.bundleId === comparison.bundleId));
        await assert.rejects(readSavedComparisonFile(context, changed, comparison.bundleId, "html"));
    }
    await unlink(comparison.files[name]);
    await assert.rejects(readSavedComparisonFile(context, state, comparison.bundleId, "html"), /no longer available/);
    assert.equal((await readSavedComparisonFile(context, state, comparison.bundleId, "markdown")).format, "markdown", "An explicit independent format remains readable, not an implicit fallback");
    await assert.rejects(readSavedComparisonFile(context, { ...state, exports: [] }, comparison.bundleId, "html"), /no longer available/);
});

test("saved comparison files keep independent authorization after source removal and reply-permission change", { timeout: 30000 }, async t => {
    const { context, sources, comparison } = await setup(t);
    const before = await readFile(comparison.files["comparison-report.html"]);
    await updateBoardState(context, state => {
        state.exports = state.exports.filter(entry => !sources.some(source => source.bundleId === entry.bundleId));
        state.personalEvaluation ??= defaultPersonalEvaluation();
        state.personalEvaluation.consent.revision++;
    });
    const result = await readSavedComparisonFile(context, await loadBoardState(context), comparison.bundleId, "html");
    assert.deepEqual(result.bytes, before);
    assert.ok(result.artifact.sourceReports.every(source => !source.available));
});
