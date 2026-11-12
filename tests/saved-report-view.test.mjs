import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { privateFixture, fixture } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { readSavedReportView, reportHash } from "../lib/report-artifacts.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";

async function save(controller, context, options, pair) {
    const state = await loadBoardState(context);
    const prepared = await controller.preview("saved-view", undefined, { promptMode: "masked", ...options },
        pair ? undefined : { kind: "all", revision: state.revision }, pair);
    await controller.review("saved-view", prepared.previewId, true, options.timeContext);
    return (await controller.confirm("saved-view", prepared.previewId, true, options.timeContext)).bundle;
}

for (const format of ["json", "markdown"]) test(`exact ad69 ${format} artifacts retain their historical rendered wording on Open`, async t => {
    const fixtures = JSON.parse(await readFile(new URL("./report-origin-v3.fixture.json", import.meta.url), "utf8"));
    const artifact = fixtures.artifacts.find(item => item.format === format);
    const assetPaths = {
        fontLicense: ["assets", "fonts", "OFL.txt"],
        lightWordmark: ["assets", "wire-wordmark.svg"],
        darkWordmark: ["assets", "wire-wordmark-dark.svg"],
    };
    const assets = Object.fromEntries(await Promise.all(artifact.inlineAssets.map(async name => {
        const bytes = await readFile(path.join(import.meta.dirname, "..", ...assetPaths[name]));
        return [name, { sha256: reportHash(bytes), bytes: bytes.length }];
    })));
    const materialization = Object.entries(fixtures.inlineAssetMaterializations).find(([, candidate]) =>
        artifact.inlineAssets.every(name => assets[name].sha256 === candidate[name].sha256
            && assets[name].bytes === candidate[name].bytes))?.[0];
    assert.ok(materialization, "Inline report assets must match an old-reader-qualified materialization.");
    const expectedView = artifact.expectedViews[materialization];
    const unpack = packed => {
        const bytes = gunzipSync(Buffer.from(packed.gzipBase64, "base64"));
        assert.equal(bytes.length, packed.bytes);
        assert.equal(reportHash(bytes), packed.sha256);
        return bytes;
    };
    const { context } = await privateFixture(t, []);
    const entry = JSON.parse(unpack(artifact.registration).toString("utf8"));
    entry.bundleDir = path.join(context.dataDir, "exports", entry.bundleId);
    entry.files = {};
    await mkdir(entry.bundleDir, { recursive: true });
    for (const [name, packed] of Object.entries(artifact.files)) {
        entry.files[name] = path.join(entry.bundleDir, name);
        await writeFile(entry.files[name], unpack(packed));
    }
    await updateBoardState(context, state => { state.exports.push(entry); });
    const before = await loadBoardState(context);
    const view = await readSavedReportView(context, before, entry.bundleId);
    assert.equal(view.sourceFormat, format);
    assert.match(view.text, /Recorded author evidence conflicts\./);
    assert.match(view.text, /The host did not record the author/);
    assert.doesNotMatch(view.text, /WIRE could not reconcile the recorded origin evidence/);
    assert.equal(reportHash(view.text), expectedView.sha256, "The complete historical reading, not only saved file bytes, stays frozen.");
    assert.equal(Buffer.byteLength(view.text), expectedView.bytes);
    assert.deepEqual(await loadBoardState(context), before);
    for (const [name, packed] of Object.entries(artifact.files)) {
        assert.deepEqual(await readFile(entry.files[name]), unpack(packed));
    }
});

test("new report origin explanations are versioned and survive JSON-only saved reading", async t => {
    const record = fixture("current-origin");
    record.userPrompt.authorship = { actor: "unknown", basis: "conflicting-source" };
    const { context } = await privateFixture(t, [record]), controller = createExportController(context);
    const bundle = await save(controller, context, { formats: ["json"], promptMode: "original" });
    const snapshot = JSON.parse(await readFile(bundle.files["product-report.json"], "utf8"));
    assert.deepEqual(snapshot.presentation, { schemaVersion: 3, originExplanationVersion: 1 });
    t.mock.method(promptAuthorship, "reason", () => "Changed live screen explanation.");
    const state = await loadBoardState(context), view = await readSavedReportView(context, state, bundle.bundleId);
    assert.match(view.text, /WIRE could not reconcile the recorded origin evidence\./);
    assert.doesNotMatch(view.text, /Recorded author evidence conflicts\.|Changed live screen explanation/);
});

test("JSON-only activity, period and comparison reports render their frozen saved facts without writes", async t => {
    const { records, input } = periodFixture();
    records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const options = { formats: ["json"], timeContext: input.options.timeContext };
    const first = await save(controller, context, { ...options, title: "Earlier saved activity" });
    const second = await save(controller, context, { ...options, title: "Later saved activity" });
    const state = await loadBoardState(context);
    const pair = buildPeriodComparison(state, { ...input, expectedRevision: state.revision });
    const period = await save(controller, context, { ...options, title: "Saved periods" }, pair);
    const prepared = await controller.previewComparison("saved-view", first.bundleId, second.bundleId,
        { ...options, title: "Saved comparison" });
    await controller.reviewComparison("saved-view", prepared.previewId, true, options.timeContext);
    const comparison = (await controller.confirmComparison("saved-view", prepared.previewId, true, options.timeContext)).bundle;
    const bundles = [first, period, comparison], bytes = new Map();
    for (const bundle of bundles) for (const file of Object.values(bundle.files)) bytes.set(file, await readFile(file));
    await replaceEvidence(context, () => ({ records: [], importCoverage: state.importCoverage }));
    const savedState = await loadBoardState(context);
    for (const bundle of bundles) {
        const view = await readSavedReportView(context, savedState, bundle.bundleId, bundle.kind ?? "report");
        assert.equal(view.format, "html");
        assert.equal(view.sourceFormat, "json");
        assert.ok(view.text.includes(bundle.title));
        assert.match(view.text, /<h1>/);
        assert.equal(view.artifact.bundleId, bundle.bundleId);
        assert.equal(view.source, undefined);
        if (bundle === period) assert.match(view.text, /Period A/);
        assert.equal(Object.keys(bundle.files).some(name => name.endsWith(".html")), false);
    }
    assert.deepEqual(await loadBoardState(context), savedState);
    for (const [file, original] of bytes) assert.deepEqual(await readFile(file), original);
});

test("report view refuses changed JSON and a missing declared HTML instead of falling back", async t => {
    const { context } = await privateFixture(t), controller = createExportController(context);
    const json = await save(controller, context, { formats: ["json"] });
    const html = await save(controller, context, { formats: ["html", "json"] });
    const state = await loadBoardState(context);
    await writeFile(json.files["product-report.json"], "{}");
    await assert.rejects(readSavedReportView(context, state, json.bundleId), /JSON changed/);
    await writeFile(html.files["product-report.html"], "changed HTML");
    await assert.rejects(readSavedReportView(context, state, html.bundleId), /HTML changed/);
    const missing = structuredClone(state);
    delete missing.exports.find(entry => entry.bundleId === html.bundleId).files["product-report.html"];
    await assert.rejects(readSavedReportView(context, missing, html.bundleId), /HTML was not saved/);
    const wrongOwner = structuredClone(state);
    wrongOwner.exports.find(entry => entry.bundleId === json.bundleId).nativeSourceBinding = {};
    await assert.rejects(readSavedReportView(context, wrongOwner, json.bundleId), /account-authorized/);
    await assert.rejects(readSavedReportView(context, state, json.bundleId, "report", true), /not a supported legacy/);
});

test("Markdown-only reports have an in-app HTML view without changing their saved file", async t => {
    const { context } = await privateFixture(t), controller = createExportController(context);
    const bundle = await save(controller, context, { formats: ["markdown"], title: "Portable saved activity" });
    const state = await loadBoardState(context), bytes = await readFile(bundle.files["product-report.md"]);
    const view = await readSavedReportView(context, state, bundle.bundleId);
    assert.equal(view.format, "html");
    assert.equal(view.sourceFormat, "markdown");
    assert.match(view.text, /<h1>Portable saved activity<\/h1>/);
    assert.match(view.text, /<table>/);
    assert.deepEqual(await readFile(bundle.files["product-report.md"]), bytes);
    assert.deepEqual(await loadBoardState(context), state);
});

for (const presentation of [{ schemaVersion: 999 }, { schemaVersion: 3, originExplanationVersion: 999 }]) test(
    `unsupported frozen JSON presentation ${JSON.stringify(presentation)} is refused rather than reinterpreted`, async t => {
    const { context } = await privateFixture(t), controller = createExportController(context);
    const bundle = await save(controller, context, { formats: ["json"] });
    const state = await loadBoardState(context), entry = state.exports.find(item => item.bundleId === bundle.bundleId);
    const snapshot = JSON.parse(await readFile(bundle.files["product-report.json"], "utf8"));
    snapshot.presentation = presentation;
    const bytes = JSON.stringify(snapshot);
    const manifest = JSON.parse(await readFile(bundle.files["coverage-and-redaction-manifest.json"], "utf8"));
    manifest.snapshotHash = reportHash(JSON.stringify(snapshot));
    manifest.files["product-report.json"] = { sha256: reportHash(bytes), bytes: Buffer.byteLength(bytes) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(bundle.files["product-report.json"], bytes);
    await writeFile(bundle.files["coverage-and-redaction-manifest.json"], manifestBytes);
    entry.manifestHash = reportHash(manifestBytes); entry.snapshotHash = manifest.snapshotHash;
    await assert.rejects(readSavedReportView(context, state, bundle.bundleId), /cannot be shown as a report/);
    assert.equal(await readFile(bundle.files["product-report.json"], "utf8"), bytes);
});
