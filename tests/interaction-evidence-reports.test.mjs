import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController, writeBundle } from "../lib/export.mjs";
import { renderHtmlReport, renderMarkdownReport } from "../lib/product-report.mjs";
import { hasCurrentReportPresentation } from "../lib/report-presentation.mjs";
import { readSavedReportFile, reportHash } from "../lib/report-artifacts.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { renderPeriodReportHtml, renderPeriodReportMarkdown } from "../lib/period-report-output.mjs";
import { readSavedReportView } from "../lib/report-artifacts.mjs";

const key = "a".repeat(64);
test("token choices freeze across files and verified JSON-only reopening", async t => {
    const a = record(), unmetered = record("unmetered"), privateModel = record("private-model");
    for (const [n,r] of [a,unmetered,privateModel].entries()) {
        r.userPrompt.sourceEventId = `prompt-${n}`;
        r.toolCalls[0].toolCallId = `tool-${n}`;
        r.toolCalls[0].startEventId = `start-${n}`;
        r.toolCalls[0].completionEventId = `end-${n}`;
    }
    const call = { receiptId:"private-receipt", apiCallId:"private-call", model:"gpt-4.1", at:a.capturedAt,
        tokens:{freshInput:50000,cacheRead:100000,cacheWrite:0,output:10000} };
    a.usageCalls = [call]; privateModel.usageCalls = [{ ...call, model:"private-model-name" }];
    const {context} = await privateFixture(t,[a,unmetered,privateModel]), controller=createExportController(context);
    const options={tokens:true,rows:true,question:"model"}, bundle=await buildSanitizedBundle([a,unmetered,privateModel],key,{
        promptMode:"none", formats:["html","markdown","pdf","json"], usageOptions:options });
    const facts = bundle.snapshot.usageFacts.cohorts.selected;
    assert.deepEqual([facts.total,facts.metered,facts.eligible,facts.rows.length],[320000,2,3,3]);
    for (const name of ["product-report.json","coverage-and-redaction-manifest.json"])
        assert.doesNotMatch(bundle.files[name],/"(?:pricing|priced|unpriced|usd|rateDate|amounts|dollars)"\s*:/i);
    assert.deepEqual(facts.groups.map(g=>[g.label,g.total,g.cacheReadShare]),[
        ["gpt-4.1",160000,2/3],["Other model",160000,2/3],
    ]);
    const task=getDocument({data:new Uint8Array(bundle.files["product-report.pdf"])});
    let text="";
    try { const doc=await task.promise; for(let page=1;page<=doc.numPages;page++)
        text+=" "+(await (await doc.getPage(page)).getTextContent()).items.map(i=>i.str).join(" "); } finally { await task.destroy(); }
    for (const content of [text,bundle.previewHtml,bundle.files["product-report.html"],bundle.files["product-report.md"]]) {
        assert.match(content,/320,000 tokens/);
        assert.match(content,/Usage by model/);
        assert.doesNotMatch(content,/Est\. USD|retail cost|Unpriced|\$\d/i);
        assert.doesNotMatch(content,/private-model-name|private-receipt|private-call/);
    }
    const preview = await controller.preview("usage-proof",undefined,{formats:["json"],promptMode:"none",usageOptions:options},
        { kind:"all",revision:(await loadBoardState(context)).revision });
    await controller.review("usage-proof",preview.previewId,true);
    const saved=(await controller.confirm("usage-proof",preview.previewId,true)).bundle;
    const opened=await readSavedReportView(context,await loadBoardState(context),saved.bundleId);
    assert.match(opened.text,/320,000 tokens/); assert.match(opened.text,/Usage by model/);
    const off=await buildSanitizedBundle([a],key,{formats:["json"],usageOptions:{tokens:false,rows:true}});
    assert.equal(off.snapshot.usageFacts,undefined); assert.doesNotMatch(off.previewHtml,/Token &amp; cache breakdown/);
});
function record(id = "invented-timing-report") {
    const value = fixture(id);
    Object.assign(value.toolCalls[0], { durationMs: 11850, startedAt: "2026-10-01T12:00:00.000Z",
        completedAt: "2026-10-01T12:00:11.850Z", completionEventId: "invented-report-completion" });
    return value;
}
test("new output stamps presentation v3 with ms-first timing, leaving envelope and metric definitions unchanged", async () => {
    const bundle = await buildSanitizedBundle([record()], key, { promptMode: "none", formats: ["html", "markdown", "json", "pdf"] });
    assert.equal(bundle.snapshot.schemaVersion, 3);
    assert.equal(bundle.snapshot.presentation.schemaVersion, 3);
    assert.equal(bundle.snapshot.presentation.originExplanationVersion, 1);
    assert.deepEqual(JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]).presentation, bundle.snapshot.presentation);
    assert.equal(bundle.snapshot.evaluationFacts.metricProjectionVersion, 4);
    const metric = bundle.snapshot.evaluationFacts.metrics.find(item => item.definitionId === "tool-duration");
    assert.equal(metric.value, 11850);
    assert.equal(metric.boundary, "tool-start-to-completion");
    assert.equal(metric.unit, "ms");
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"]]) assert.match(content, /11,850 ms \(11\.85 s\)/);
    const task = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: false });
    try {
        const pdf = await task.promise, text = [];
        for (let n = 1; n <= pdf.numPages; n++) text.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => item.str).join(" "));
        assert.match(text.join(" "), /11,850 ms \(11\.85 s\)/);
    } finally { await task.destroy(); }
    const older = { ...bundle.snapshot, presentation: { schemaVersion: 2 } };
    for (const content of [renderHtmlReport(older.records, { snapshot: older }), renderMarkdownReport(older.records, { snapshot: older })]) {
        assert.match(content, /11\.85 s \(11850 ms\)/);
        assert.doesNotMatch(content, /11,850 ms \(11\.85 s\)/);
    }
    assert.equal(hasCurrentReportPresentation(older), false);
    assert.equal(hasCurrentReportPresentation(bundle.snapshot), true);
});

test("saved v2 formats stay byte-identical when a new report is saved", async t => {
    const { context } = await privateFixture(t, [record()]);
    const bundle = await buildSanitizedBundle([record()], key, { promptMode: "none", formats: ["html", "markdown", "json"] });
    bundle.snapshot.presentation = { schemaVersion: 2 };
    bundle.privacy.reviewerConfirmed = true;
    bundle.files["product-report.html"] = renderHtmlReport(bundle.records, { snapshot: bundle.snapshot });
    bundle.files["product-report.md"] = renderMarkdownReport(bundle.records, { snapshot: bundle.snapshot });
    bundle.files["product-report.json"] = JSON.stringify(bundle.snapshot, null, 2) + "\n";
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    Object.assign(manifest, { presentation: bundle.snapshot.presentation, privacyReview: bundle.privacy,
        snapshotHash: reportHash(JSON.stringify(bundle.snapshot)) });
    manifest.files = Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
        .map(([name, content]) => [name, { bytes: Buffer.byteLength(content), sha256: reportHash(content) }]));
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    const saved = await writeBundle(context, bundle, await loadBoardState(context));
    await updateBoardState(context, state => state.exports.push(saved));
    const bytes = await Promise.all(Object.values(saved.files).map(async file => [file, await readFile(file)]));
    const controller = createExportController(context);
    const preview = await controller.preview("timing-v3", undefined, { promptMode: "none", formats: ["html", "json"] },
        { kind: "all", revision: (await loadBoardState(context)).revision });
    await controller.review("timing-v3", preview.previewId, true);
    const current = (await controller.confirm("timing-v3", preview.previewId, true)).bundle;
    const state = await loadBoardState(context);
    for (const [format, name] of [["html", "product-report.html"], ["markdown", "product-report.md"], ["json", "product-report.json"]]) {
        assert.equal((await readSavedReportFile(context, state, saved.bundleId, format)).bytes.toString(), bundle.files[name]);
    }
    for (const [file, original] of bytes) assert.deepEqual(await readFile(file), original);
    assert.equal((await loadBoardState(context)).exports.length, 2);
});

test("period timing, exact matching rows and whole-interaction timing use the selected presentation without changing facts", () => {
    const { state, input } = periodFixture();
    const value = buildPeriodComparison(state, input);
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), "2026-03-11T12:00:00.000Z").frozen;
    const records = [...new Set(Object.values(frozen.periods).flatMap(side => side.scenarioRefs))]
        .map(scenarioId => ({ scenarioId, toolCalls: [], graphActivities: [], httpRecords: [], prompts: [] }));
    const snapshot = { periodComparison: frozen, records, preparedAtDisplay: "Mar 11, 2026", promptMode: "none", presentation: { schemaVersion: 3 } };
    const before = JSON.stringify(snapshot);
    for (const content of [renderPeriodReportHtml(snapshot), renderPeriodReportMarkdown(snapshot)]) {
        assert.match(content, /1,000 ms \(1 s\)/);
        assert.match(content, /3,000 ms \(3 s\)/);
    }
    assert.equal(JSON.stringify(snapshot), before);
    const older = { ...snapshot, presentation: { schemaVersion: 2 } };
    assert.doesNotMatch(renderPeriodReportHtml(older), /1,000 ms \(1 s\)/);
});
