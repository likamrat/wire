import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { collectedResultFixture } from "./retained-result-fixture.mjs";
import { privateFixture } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { readSavedArtifactFile, readSavedComparison, loadSavedReportSource } from "../lib/report-artifacts.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { projectReportResults } from "../lib/report-result-projection.mjs";
import { validateReportResultFacts } from "../lib/report-result-contract.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { collectorFor } from "../lib/collector.mjs";
import { indexSearchText, rankTextSearch } from "../lib/search-text.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { comparisonDocumentText } from "../lib/search-corpus-content.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { reportResultContent } from "../lib/report-result-output.mjs";
import { compareReportResultFacts } from "../lib/report-result-facts.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";

const message = "Editing is disabled for this item. Choose an editable item.";
const returned = { statusCode: 403, error: { error: { code: "AccessDenied", message,
    details: [{ code: "EditingDisabled", message: "The item must allow changes." }] } } };
const completion = { success: false, error: { code: "failure",
    message: `MCP server 'workiq': {"results":[${JSON.stringify(returned)},{"data":{"text":"${"EXCLUDED_BODY".repeat(1000)}"]}}` } };

async function outputText(name, value) {
    const bytes = value?.encoding === "base64" ? Buffer.from(value.data, "base64") : value;
    if (!name.endsWith(".pdf")) return String(bytes);
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await task.promise;
    try {
        const pages = [];
        for (let index = 1; index <= pdf.numPages; index++) pages.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str).join(" "));
        return pages.join("\n");
    } finally { await task.destroy(); }
}

test("ordinary partial-error collection survives restart, literal Search and default-off report disclosure", { timeout: 30000 }, async t => {
    const app = await collectedResultFixture(t, completion);
    const call = app.record.toolCalls[0];
    assert.equal(call.resultEvidence.contentStatus, "partial");
    assert.equal(call.resultEvidence.resultCount, null);
    assert.equal(call.apiResults[0].errorDiagnostic.message, message);
    assert.match(createRecordedResults({ screen: true }).failureReason(call), /Editing is disabled.*AccessDenied.*403/);
    assert.match(JSON.stringify(createRecordedResults().resultDetails(call.resultEvidence)), /total entry count is unknown/);
    const source = await createCorpusSources(app.context, { source: state => collectorFor(app.context).assessmentSource(state) }).scan();
    const matches = await rankTextSearch(source.entries.map(indexSearchText), "AccessDenied", ["action"], new AbortController().signal);
    assert.equal(matches.length, 2, "The tool call and its separately qualified returned entry are distinct searchable units.");
    const hits = matches.map(match => source.entries.find(entry => entry.id === match.id));
    assert.deepEqual(hits.map(hit => hit.coverage.layer).sort(), ["reported-api", "tool"]);
    assert.ok(hits.every(hit => hit.content.includes(message)));
    assert.ok(hits.every(hit => new URLSearchParams(hit.target.href.split("?")[1]).get("request") === app.record.scenarioId));
    const returnedHit = hits.find(hit => hit.coverage.layer === "reported-api");
    assert.ok(new URLSearchParams(returnedHit.target.href.split("?")[1]).has("callRevision"));
    const reports = createExportController(app.context), state = await loadBoardState(app.context);
    const preview = await reports.preview("failure-owner", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "all", revision: state.revision });
    assert.doesNotMatch(JSON.stringify(preview.files), /Editing is disabled|EXCLUDED_/);
    assert.equal(preview.snapshot.resultFacts.calls[0].observations[0].contentStatus, "partial");
    assert.equal(preview.snapshot.resultFacts.calls[0].observations[0].resultCount, null);
    assert.equal(preview.snapshot.resultFacts.calls[0].observations[0].returnedEntries[0].errorCode, "AccessDenied");
    await app.unchanged();
});

test("reviewed report, saved Compare and period Compare freeze partial returned errors in every format", { timeout: 60000 }, async t => {
    const app = await collectedResultFixture(t, completion);
    const before = structuredClone(app.record), after = structuredClone(app.record);
    before.toolCalls[0].resultEvidence.contentStatus = "body-excluded";
    before.toolCalls[0].resultEvidence.resultCount = 1;
    const { context } = await privateFixture(t, [before]);
    const reports = createExportController(context), owner = "failure-owner", formats = ["json", "html", "markdown", "pdf"];
    async function save(selectedFormats = formats) {
        const state = await loadBoardState(context);
        const preview = await reports.preview(owner, undefined, { promptMode: "none", resultText: true, formats: selectedFormats },
            { kind: "all", revision: state.revision });
        await reports.review(owner, preview.previewId, true);
        return (await reports.confirm(owner, preview.previewId, true)).bundle.bundleId;
    }
    const earlier = await save(["json"]);
    const original = await readSavedArtifactFile(context, await loadBoardState(context), earlier, "report", "json");
    await replaceEvidence(context, () => ({ records: [after] }));
    const later = await save(), state = await loadBoardState(context);
    const saved = await loadSavedReportSource(context, state, later);
    assert.equal(saved.resultFacts.calls[0].observations[0].contentStatus, "partial");
    assert.equal(saved.resultFacts.calls[0].observations[0].resultCount, null);
    assert.equal(saved.resultText.copies.find(copy => copy.kind === "error-message").text, message);
    for (const format of formats) {
        const file = await readSavedArtifactFile(context, state, later, "report", format);
        const text = await outputText(file.name, file.bytes);
        assert.match(text, /Editing is disabled/, format);
        assert.match(text, /partial/, format);
        assert.doesNotMatch(text, /EXCLUDED_/, format);
        if (format !== "json") assert.match(text, /total entry count is unknown/, format);
    }
    const preview = await reports.previewComparison(owner, earlier, later, { formats, resultText: true });
    assert.equal(preview.comparison.resultComparison.shared.changedTypedFacts, 1);
    assert.match(comparisonDocumentText(preview.comparison), /Editing is disabled/);
    for (const [name, value] of Object.entries(preview.files)) {
        const text = await outputText(name, value);
        assert.match(text, /Editing is disabled/);
        assert.match(text, /partial/);
        if (!name.endsWith(".json")) assert.match(text, /total entry count unknown/);
    }
    await reports.reviewComparison(owner, preview.previewId, true);
    const comparison = await reports.confirmComparison(owner, preview.previewId, true);
    const reopened = await readSavedComparison(context, await loadBoardState(context), comparison.bundle.bundleId);
    assert.match(JSON.stringify(reopened.comparison.resultTextSources), /Editing is disabled/);
    assert.deepEqual((await readSavedArtifactFile(context, await loadBoardState(context), earlier, "report", "json")).bytes, original.bytes);
    const json = await readSavedArtifactFile(context, await loadBoardState(context), later, "report", "json");
    const manifest = await readSavedArtifactFile(context, await loadBoardState(context), later, "report", "manifest");
    const searched = await extractReportFile({ format: "json", bytes: json.bytes, snapshot: JSON.parse(json.bytes),
        manifest: JSON.parse(manifest.bytes) });
    assert.match(searched.content, /Editing is disabled/);

    const records = [before, after].map((value, index) => {
        const record = structuredClone(value);
        record.scenarioId += "-" + index;
        record.capturedAt = `2026-11-0${index + 1}T12:00:00.000Z`;
        record.toolCalls[0].toolCallId += "-" + index;
        record.toolCalls[0].startEventId += "-" + index;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    await replaceEvidence(context, () => ({ records }));
    const periodState = await loadBoardState(context);
    const period = buildPeriodComparison(periodState, { schemaVersion: 1, expectedRevision: periodState.revision,
        scenarioIds: records.map(record => record.scenarioId), withinServices: [],
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-11-01", to: "2026-11-01" }, later: { from: "2026-11-02", to: "2026-11-02" } } });
    const periodPreview = await reports.preview(owner, undefined,
        { promptMode: "none", resultText: true, formats, timeContext: period.timeContext }, undefined, period);
    for (const [name, value] of Object.entries(periodPreview.files)) {
        const text = await outputText(name, value);
        assert.match(text, /Editing is disabled/);
        assert.match(text, /partial/);
    }
    await reports.review(owner, periodPreview.previewId, true, period.timeContext);
    const periodSaved = await reports.confirm(owner, periodPreview.previewId, true, period.timeContext);
    const periodFile = await readSavedArtifactFile(context, await loadBoardState(context), periodSaved.bundle.bundleId, "report", "json");
    assert.equal(JSON.parse(periodFile.bytes).periodComparison.periods.later.resultFacts.calls[0].observations[0].contentStatus, "partial");
    await app.unchanged();
});

test("partial facts reject invented totals and retain their meaning in shared report projections", () => {
    const template = { version: 1, source: "sdk-result", applicationError: null, statusCode: null, resultCount: null, contentStatus: "partial" };
    const record = { scenarioId: "partial", sourceSessionId: "invented", toolCalls: [{ tool: "workiq-fetch",
        toolCallId: "call", startEventId: "start", resultEvidence: template, apiResults: [], reportedOutcome: "failed", toolSucceeded: false }] };
    const facts = projectReportResults([record], "a".repeat(64)).facts;
    assert.match(JSON.stringify(reportResultContent(facts)), /total entry count is unknown/);
    const invalid = structuredClone(facts); invalid.calls[0].observations[0].resultCount = 0;
    assert.throws(() => validateReportResultFacts(invalid), /Invalid frozen result facts/);
    const complete = structuredClone(facts); complete.calls[0].observations[0].contentStatus = "body-excluded";
    delete complete.calls[0].observations[0].interpretation;
    assert.match(JSON.stringify(createReportComparison().resultComparisonContent(compareReportResultFacts(complete, facts))), /total entry count unknown/);
});
