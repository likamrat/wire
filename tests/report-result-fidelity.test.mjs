import test from "node:test";
import assert from "node:assert/strict";
import { fixture, privateFixture } from "./helpers.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { loadSavedReportSource, readSavedArtifactFile, readSavedComparison } from "../lib/report-artifacts.mjs";
import { nativeReportFrame, nativeReportKey } from "./native-report-fixtures.mjs";
import { coworkSourceContext, sourceObservation } from "./cowork-source-adapter-fixtures.mjs";
import { adaptCoworkSourceRecordsWithResultFacts, COWORK_MATCHED_RESULT_ADAPTER_VERSION, COWORK_RESULT_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { committedNativeReportFixture, preserveReportProof } from "./native-report-controller-fixture.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { projectReportResults } from "../lib/report-result-projection.mjs";
import { compareReportResultFacts, validateReportResultFacts } from "../lib/report-result-facts.mjs";
import { resultMetadata } from "../lib/history.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { comparisonDocumentText } from "../lib/search-corpus-content.mjs";
import { projectReportResultText, projectComparisonResultText } from "../lib/report-result-text.mjs";
import { reportResultHtml, resultTextHtml, comparisonResultTextHtml, resultComparisonContent, resultComparisonHtml, resultComparisonMarkdown } from "../lib/report-result-output.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";
import { validateComparisonResultText } from "../lib/report-result-text-shape.mjs";
import { renderPdf } from "../lib/pdf.mjs";

function sourceRecord(applicationError) {
    const record = fixture("result-report");
    record.toolCalls[0].resultEvidence = { version: 1, source: "sdk-result", applicationError, statusCode: null,
        contentStatus: "body-excluded", resultCount: null,
        ...(applicationError ? { diagnostic: { version: 1, source: "mcp-result-text", status: "recorded",
            message: "Required scope [Tasks.ReadWrite] is missing." } } : {}) };
    return record;
}

test("result reading uses grammatical coverage and human descriptions without changing facts", () => {
    const project = flag => projectReportResults([sourceRecord(flag)], "a".repeat(64)).facts;
    const unknown = project(null), before = JSON.stringify(unknown);
    assert.doesNotMatch(reportResultHtml(unknown), /\b1 calls\b|\b1 application errors\b|structured result facts/);
    assert.equal(JSON.stringify(unknown), before);
    const compared = compareReportResultFacts(project(false), project(true)), frozen = JSON.stringify(compared);
    assert.doesNotMatch(resultComparisonContent(compared).shared, /typed result facts|call reference/);
    assert.equal(JSON.stringify(compared), frozen);
    const older = fixture("older-result-reading");
    older.toolCalls[0].apiResults = [];
    const oldOutput = reportResultHtml(projectReportResults([older], "a".repeat(64)).facts);
    assert.match(oldOutput, /Report call 1/);
    assert.match(oldOutput, /result-body details were not saved/);
    assert.doesNotMatch(oldOutput, /manifest lists 1 more call/);
});

test("result-text reading distinguishes not selected, selected empty and source text not included", () => {
    const facts = projectReportResults([sourceRecord(false)], "a".repeat(64)).facts;
    const empty = { version: 1, mode: "masked", copies: [],
        coverage: { total: 0, included: 0, omitted: 0, unavailable: 0, edited: 0, bytes: 0 } };
    assert.match(resultTextHtml(undefined, facts), /not selected/);
    assert.match(resultTextHtml(empty, facts), /selected.*no copies/);
    assert.doesNotMatch(resultTextHtml(empty, facts), /0 masked|0 omitted|0 unavailable/);
    assert.equal(comparisonResultTextHtml(undefined), "", "Legacy comparison output stays unchanged");
    assert.match(comparisonResultTextHtml(null), /not selected for this comparison/);
    const selected = comparisonResultTextHtml({ version: 1, mode: "masked", sources: [
        { resultText: null, reason: "not-in-source-report" }, { resultText: empty, reason: null },
    ] });
    assert.match(selected, /not included in this saved report/);
    assert.match(selected, /selected.*no copies/);
    assert.doesNotMatch(selected, /0 masked|0 omitted|0 unavailable/);
});

for (const mixed of [false, true]) test(`native interpretation changes withhold unqualified result cohorts and copies${mixed ? " without hiding GitHub facts" : ""}`, async () => {
    const loaded = [];
    for (const [index, parserVersion] of [COWORK_RESULT_ADAPTER_VERSION, COWORK_MATCHED_RESULT_ADAPTER_VERSION, COWORK_MATCHED_RESULT_ADAPTER_VERSION].entries()) {
        const source = coworkSourceContext(); source.capture.parserVersion = parserVersion;
        const frame = nativeReportFrame(adaptCoworkSourceRecordsWithResultFacts([sourceObservation({
            id: `result-${index}`, event: "tx", data: { tid: `call-${index}`, tn: "mcp__outlook__MoveMessage",
                ok: false, err: `Native source permission detail ${index}.`, d: "Recorded source description", out: "" },
        })], source));
        const record = sourceRecord(true);
        record.scenarioId += index; record.toolCalls[0].toolCallId += index; record.toolCalls[0].startEventId += index;
        const bundle = await buildSanitizedBundle(mixed ? [record] : [], nativeReportKey,
            { promptMode: "none", resultText: true, formats: ["json"] }, undefined, undefined, undefined, undefined, undefined, frame);
        const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
        const reference = { bundleId: bundle.bundleId, snapshotHash: manifest.snapshotHash };
        loaded.push({ reference, resultFacts: bundle.snapshot.resultFacts, resultText: bundle.snapshot.resultText,
            envelope: { ...reference, schemaVersion: 2, disclosureReviewed: true,
                nativeEvidence: bundle.snapshot.nativeEvidence, resultFacts: bundle.snapshot.resultFacts } });
    }
    assert.notDeepEqual(loaded[0].envelope.nativeEvidence.definition, loaded[1].envelope.nativeEvidence.definition);
    for (const cohort of ["non-overlapping", "later-additions"]) {
        const comparison = compareFrozenReportFacts(loaded[0].envelope, loaded[1].envelope,
            { cohort, identityRelation: "same-namespace", metricProjectionVersion: 4, resultProjectionVersion: 1 });
        const native = comparison.nativeComparison.units.find(row => row.unit === "native-tool-call");
        assert.equal(native.baselineState, "cohort-unavailable");
        const results = comparison.resultComparison.groups.find(group => group.source === "microsoft-365-cowork");
        assert.equal(results.baseline, null);
        assert.equal(results.later, null);
        assert.equal(comparison.resultComparison.shared.count, null);
        const copies = projectComparisonResultText(loaded.slice(0, 2), { cohort, resultText: true, manualTerms: [] }, comparison);
        assert.doesNotMatch(JSON.stringify(copies), /Native source permission detail/);
        const sources = loaded.slice(0, 2).map(source => ({ report: source.reference, resultFacts: source.resultFacts }));
        assert.doesNotThrow(() => validateComparisonResultText(copies, sources, comparison));
        if (mixed) {
            assert.equal(comparison.resultComparison.groups.find(group => group.source === "github-copilot").baseline.calls, 1);
            assert.match(JSON.stringify(copies), /Required scope/);
            assert.ok(copies.sources.every(source => source.unavailableSources.includes("microsoft-365-cowork")));
            assert.match(comparison.primaryEvidence.heading, /^GitHub Copilot: Recorded tool completion$/);
            assert.match(comparison.primaryEvidence.note, /GitHub population only/);
            const snapshot = { title: "Invented mixed comparison", preparedAtDisplay: "Oct 29, 2026", bundleId: "invented-comparison", sourceReports: loaded.slice(0, 2).map(source => source.reference) };
            for (const output of [renderComparisonHtml(comparison, snapshot), renderComparisonMarkdown(comparison, snapshot)]) {
                assert.match(output, /GitHub Copilot: Recorded tool completion/);
                assert.match(output, /GitHub population only/);
            }
        } else assert.ok(copies.sources.every(source => source.resultText === null && source.reason === "cohort-unqualified"));
    }
    const snapshot = compareFrozenReportFacts(loaded[0].envelope, loaded[1].envelope,
        { identityRelation: "same-namespace", cohort: "snapshots", metricProjectionVersion: 4, resultProjectionVersion: 1 });
    const nativeSnapshot = snapshot.resultComparison.groups.find(group => group.source === "microsoft-365-cowork");
    assert.equal(nativeSnapshot.baseline.calls, 1);
    assert.equal(nativeSnapshot.later.calls, 1);
    assert.equal(nativeSnapshot.overlappingReferences, null);
    assert.equal(snapshot.resultComparison.identityRelation, "unverified");
    const compatible = compareFrozenReportFacts(loaded[1].envelope, loaded[2].envelope,
        { identityRelation: "same-namespace", cohort: "non-overlapping", metricProjectionVersion: 4, resultProjectionVersion: 1 });
    const qualified = compatible.resultComparison.groups.find(group => group.source === "microsoft-365-cowork");
    assert.equal(qualified.baseline.calls, 1); assert.equal(qualified.later.calls, 1);
    assert.equal(qualified.overlappingReferences, 0);
    assert.match(JSON.stringify(projectComparisonResultText(loaded.slice(1), { resultText: true, cohort: "non-overlapping", manualTerms: [] }, compatible)),
        /Native source permission detail/);
});

for (const mixed of [false, true]) test(`task-only zero-call native reports retain source qualification${mixed ? " beside GitHub calls" : ""}`, async () => {
    const loaded = [];
    for (const [index, parserVersion] of [COWORK_RESULT_ADAPTER_VERSION, COWORK_MATCHED_RESULT_ADAPTER_VERSION, COWORK_MATCHED_RESULT_ADAPTER_VERSION].entries()) {
        const source = coworkSourceContext(); source.capture.parserVersion = parserVersion;
        const frame = nativeReportFrame(adaptCoworkSourceRecordsWithResultFacts([sourceObservation({
            task: { sessionId: source.scope.conversationId, taskId: `task-only-${index}`, state: "completed" },
        })], source));
        const github = sourceRecord(true);
        github.scenarioId += index; github.toolCalls[0].toolCallId += index; github.toolCalls[0].startEventId += index;
        const bundle = await buildSanitizedBundle(mixed ? [github] : [], nativeReportKey, { promptMode: "none", resultText: true, formats: ["json"] },
            undefined, undefined, undefined, undefined, undefined, frame);
        const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
        const reference = { bundleId: bundle.bundleId, snapshotHash: manifest.snapshotHash };
        assert.equal(bundle.snapshot.nativeEvidence.conversations.length, 1);
        assert.equal(bundle.snapshot.resultFacts.calls.filter(call => call.source === "microsoft-365-cowork").length, 0);
        loaded.push({ reference, resultFacts: bundle.snapshot.resultFacts, resultText: bundle.snapshot.resultText,
            envelope: { ...reference, schemaVersion: 2, disclosureReviewed: true,
                nativeEvidence: bundle.snapshot.nativeEvidence, resultFacts: bundle.snapshot.resultFacts } });
    }
    for (const cohort of ["non-overlapping", "later-additions"]) {
        for (const compatible of [false, true]) {
            const pair = compatible ? loaded.slice(1) : loaded.slice(0, 2);
            const comparison = compareFrozenReportFacts(pair[0].envelope, pair[1].envelope,
                { cohort, identityRelation: "same-namespace", metricProjectionVersion: 4, resultProjectionVersion: 1 });
            const core = comparison.nativeComparison.units.find(row => row.unit === "native-tool-call");
            assert.equal(core.baselineState, compatible ? "available" : "cohort-unavailable");
            assert.equal(core.baselineCount, compatible ? 0 : null);
            assert.equal(core.overlappingReferences, compatible ? 0 : null);
            assert.equal(comparison.resultComparison.reason, mixed ? null : compatible ? "empty-population" : "source-cohort-unavailable");
            assert.equal(comparison.resultComparison.identityRelation, compatible ? "same-namespace" : "unverified");
            assert.equal(comparison.resultComparison.shared.count, compatible ? 0 : null);
            const copies = projectComparisonResultText(pair, { cohort, resultText: true, manualTerms: [] }, comparison);
            const sources = pair.map(source => ({ report: source.reference, resultFacts: source.resultFacts }));
            assert.doesNotThrow(() => validateComparisonResultText(copies, sources, comparison));
            if (compatible) {
                assert.ok(copies.sources.every(source => source.reason === null && source.unavailableSources === undefined));
                if (!mixed) assert.ok(copies.sources.every(source => source.resultText.coverage.total === 0));
            } else {
                const group = comparison.resultComparison.groups.find(group => group.source === "microsoft-365-cowork");
                assert.equal(group.baseline, null); assert.equal(group.later, null);
                assert.equal(group.overlappingReferences, null);
                if (mixed) {
                    assert.equal(comparison.resultComparison.groups.find(group => group.source === "github-copilot").baseline.calls, 1);
                    assert.ok(copies.sources.every(source => source.unavailableSources.includes("microsoft-365-cowork")));
                    assert.match(JSON.stringify(copies), /Required scope/);
                } else assert.ok(copies.sources.every(source => source.reason === "cohort-unqualified" && source.resultText === null));
                const invalid = { ...copies, sources: pair.map(source => ({ report: source.reference, resultText: source.resultText, reason: null })) };
                assert.throws(() => validateComparisonResultText(invalid, sources, comparison), /Invalid frozen result-text/);
            }
        }
    }
});

for (const field of ["call", "entry"]) test(`pagination-only ${field} change is visible in comparison output and Search`, async () => {
    const before = projectReportResults([sourceRecord(false)], "a".repeat(64)).facts, after = structuredClone(before);
    const observation = after.calls[0].observations[0];
    if (field === "call") observation.paginationPresent = true;
    else observation.returnedEntries[0].paginationPresent = true;
    const comparison = compareReportResultFacts(before, after);
    assert.equal(comparison.shared.changedTypedFacts, 1);
    const detail = resultComparisonContent(comparison).changes[0];
    assert.notEqual(detail.baseline, detail.later);
    assert.match(detail.later, /next-page indication: recorded/);
    for (const output of [resultComparisonHtml(comparison), resultComparisonMarkdown(comparison).join("\n"),
        comparisonDocumentText({ resultComparison: comparison })]) assert.match(output, /next-page indication: recorded/);
    if (field === "entry") {
        const bytes = await renderPdf(`<!doctype html><html><body>${resultComparisonHtml(comparison)}</body></html>`);
        assert.match(await fileText("pagination.pdf", bytes), /next-\s*page indication: recorded/);
    }
});

test("new reviewed-report facts preserve application result independently of successful completion", async () => {
    const bundle = await buildSanitizedBundle([sourceRecord(true)], "a".repeat(64),
        { promptMode: "none", formats: ["json", "html", "markdown"] });
    assert.equal(bundle.snapshot.resultFacts?.version, 1);
    assert.equal(bundle.snapshot.resultFacts.calls[0].observations[0].applicationError, true);
    assert.equal(bundle.snapshot.records[0].toolCalls[0].toolSucceeded, true);
    assert.match(Object.values(bundle.files).find(value => typeof value === "string" && value.includes("<html")), /application error/i);
    assert.doesNotMatch(JSON.stringify(bundle.files), /Required scope/, "Typed result coverage does not silently disclose source prose");
});

test("reviewed saved reports and comparisons retain changed application flags with unchanged completion", async t => {
    const { context } = await privateFixture(t, [sourceRecord(false)]);
    const controller = createExportController(context), owner = "result-report-owner";
    async function saveReport() {
        const state = await loadBoardState(context);
        const preview = await controller.preview(owner, undefined,
            { promptMode: "none", resultText: true, formats: ["json", "html", "markdown"] }, { kind: "all", revision: state.revision });
        await assert.rejects(() => controller.confirm(owner, preview.previewId, true), /review/i);
        await controller.review(owner, preview.previewId, true);
        const saved = await controller.confirm(owner, preview.previewId, true);
        return saved.bundle.bundleId;
    }
    const earlier = await saveReport();
    const original = await readSavedArtifactFile(context, await loadBoardState(context), earlier, "report", "json");
    await replaceEvidence(context, () => ({ records: [sourceRecord(true)] }));
    const later = await saveReport(), state = await loadBoardState(context);
    const retained = await loadSavedReportSource(context, state, later);
    assert.equal(retained.resultFacts.calls[0].observations[0].applicationError, true);
    const inspected = await controller.inspectComparison(owner, earlier, later);
    assert.equal(inspected.comparison.toolComparison.raw.change.success, 0);
    assert.equal(inspected.comparison.resultComparison.groups[0].applicationErrorDelta, 100);
    assert.equal(inspected.comparison.resultTextSources, undefined, "Comparison result text is separately default-off");
    const disjoint = await controller.previewComparison(owner, earlier, later,
        { cohort: "non-overlapping", resultText: true, formats: ["json"] });
    assert.ok(disjoint.comparison.resultTextSources.sources.every(source => source.resultText.copies.length === 0));
    assert.equal(disjoint.comparison.resultComparison.reason, "empty-population");
    const preview = await controller.previewComparison(owner, earlier, later,
        { formats: ["json", "html", "markdown", "pdf"], resultText: true, manualTerms: ["Tasks.ReadWrite"] });
    await preserveReportProof("result-sdk-comparison", preview);
    assert.match(preview.previewHtml, /Application-result comparison/);
    assert.match(preview.previewHtml, /\+100\.0 percentage points/);
    assert.match(preview.previewHtml, /Required scope/);
    assert.match(comparisonDocumentText(preview.comparison), /Required scope/);
    assert.doesNotMatch(comparisonDocumentText(preview.comparison), /result-copy-[a-f0-9]{16}/);
    assert.doesNotMatch(preview.previewHtml, /Tasks.ReadWrite/);
    for (const [name, bytes] of Object.entries(preview.files)) {
        const data = typeof bytes === "object" && bytes.encoding === "base64" ? Buffer.from(bytes.data, "base64") : bytes;
        assert.match(await fileText(name, data), /Required scope/, name);
    }
    await controller.reviewComparison(owner, preview.previewId, true);
    const saved = await controller.confirmComparison(owner, preview.previewId, true);
    const reopened = await readSavedComparison(context, await loadBoardState(context), saved.bundle.bundleId);
    assert.equal(reopened.comparison.resultComparison.groups[0].applicationErrorDelta, 100);
    assert.match(reopened.comparison.resultTextSources.sources[1].resultText.copies[0].text, /manual redaction/);
    const after = await readSavedArtifactFile(context, await loadBoardState(context), earlier, "report", "json");
    assert.deepEqual(after.bytes, original.bytes);
});

async function fileText(name, bytes) {
    if (!name.endsWith(".pdf")) return name.endsWith(".md") ? String(bytes).replace(/\\([\[\]{}])/g, "$1") : String(bytes);
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await task.promise;
    try {
        const pages = [];
        for (let index = 1; index <= pdf.numPages; index++) pages.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str).join(" "));
        return pages.join("\n");
    } finally { await task.destroy(); }
}

test("result text is separately opted in, always masked, editable and independent of prompt/reply inclusion", async () => {
    const record = sourceRecord(true);
    const options = { promptMode: "none", resultText: true, formats: ["json", "html", "markdown", "pdf"] };
    const bundle = await buildSanitizedBundle([record], "a".repeat(64), options);
    await preserveReportProof("result-sdk-report", bundle);
    assert.equal(bundle.snapshot.resultText.mode, "masked");
    assert.equal(bundle.snapshot.resultText.copies[0].text, "Required scope [Tasks.ReadWrite] is missing.");
    for (const [name, bytes] of Object.entries(bundle.files)) {
        assert.match(await fileText(name, bytes), /Required scope/, name);
        assert.doesNotMatch(await fileText(name, bytes), /SYNTHETIC_PRIVATE_PROMPT/, name);
    }
    const searched = await extractReportFile({ format: "json", bytes: Buffer.from(bundle.files["product-report.json"]),
        snapshot: bundle.snapshot, manifest: JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]) });
    assert.match(searched.content, /Required scope \[Tasks.ReadWrite\]/);
    const key = bundle.resultReview[0].key;
    const edited = await buildSanitizedBundle([record], "a".repeat(64), { ...options, formats: ["json", "html"],
        overrides: [{ key, text: "Edited report copy: see the retained scope error." }] });
    assert.equal(edited.snapshot.resultText.copies[0].representation, "edited-copy");
    assert.equal(edited.snapshot.resultFacts.calls[0].observations[0].applicationError, true);
    assert.match(edited.previewHtml, /not original wording/);
    const masked = await buildSanitizedBundle([record], "a".repeat(64), { ...options, formats: ["html"], manualTerms: ["Tasks.ReadWrite"] });
    assert.doesNotMatch(masked.previewHtml, /Tasks.ReadWrite/);
    const omitted = await buildSanitizedBundle([record], "a".repeat(64), { ...options, formats: ["json"], overrides: [{ key, omit: true }] });
    assert.equal(omitted.snapshot.resultText.copies[0].text, null);
    assert.equal(omitted.snapshot.resultText.copies[0].representation, "omitted");
    await assert.rejects(() => buildSanitizedBundle([record], "a".repeat(64), { ...options, resultText: false,
        overrides: [{ key, text: "Stale result edit" }] }), /no longer belongs/);
});

test("live period result facts and reviewed period files preserve the exact call cohorts", async t => {
    const records = [false, true].map((flag, index) => {
        const record = sourceRecord(flag);
        record.scenarioId += index;
        record.capturedAt = `2026-10-0${index + 1}T12:00:00.000Z`;
        record.toolCalls[0].toolCallId += index;
        record.toolCalls[0].startEventId += index;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const { context } = await privateFixture(t, records), state = await loadBoardState(context);
    const value = buildPeriodComparison(state, { schemaVersion: 1, expectedRevision: state.revision,
        scenarioIds: records.map(record => record.scenarioId), withinServices: [],
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-10-01", to: "2026-10-01" }, later: { from: "2026-10-02", to: "2026-10-02" } } });
    assert.equal(value.periods.baseline.resultFacts.calls.length, 1);
    assert.equal(value.periods.later.resultFacts.calls.length, 1);
    assert.equal(value.resultComparison.groups[0].applicationErrorDelta, 100);
    const reports = createExportController(context), owner = "period-result-owner";
    const preview = await reports.preview(owner, undefined, { promptMode: "none", resultText: true,
        timeContext: value.timeContext, formats: ["json", "html", "markdown", "pdf"] }, undefined, value);
    assert.equal(preview.snapshot.resultFacts, undefined, "The text-copy union is not a third measured population");
    assert.deepEqual(preview.snapshot.periodComparison.resultComparison, value.resultComparison);
    for (const [name, bytes] of Object.entries(preview.files)) {
        const data = typeof bytes === "object" && bytes.encoding === "base64" ? Buffer.from(bytes.data, "base64") : bytes;
        const text = await fileText(name, data);
        assert.match(text, /application/i, name);
        assert.match(text, /Required scope/, name);
    }
    await reports.review(owner, preview.previewId, true, value.timeContext);
    const saved = await reports.confirm(owner, preview.previewId, true, value.timeContext);
    const file = await readSavedArtifactFile(context, await loadBoardState(context), saved.bundle.bundleId, "report", "json");
    assert.equal(JSON.parse(file.bytes).periodComparison.resultComparison.groups[0].applicationErrorDelta, 100);
});

test("native report facts retain observation-scoped descriptions/errors without inventing application outcomes or copying bodies", async () => {
    const context = coworkSourceContext();
    context.capture.parserVersion = COWORK_MATCHED_RESULT_ADAPTER_VERSION;
    const envelopes = adaptCoworkSourceRecordsWithResultFacts([sourceObservation({
        id: "native-result", event: "tx", data: { tid: "native-call", tn: "mcp__outlook__MoveMessage", ok: true,
            err: "Permission [write] is required.", d: "The source described moving the selected item.", out: "EXCLUDED_OUTPUT_BODY" },
    })], context);
    const frame = nativeReportFrame(envelopes), before = JSON.stringify(frame);
    const bundle = await buildSanitizedBundle([], nativeReportKey,
        { promptMode: "none", resultText: true, formats: ["json", "html", "markdown", "pdf"] },
        undefined, undefined, undefined, undefined, undefined, frame);
    const call = bundle.snapshot.resultFacts.calls[0];
    assert.equal(call.completion, "succeeded");
    assert.equal(call.observations[0].applicationError, null);
    assert.equal(call.observations[0].descriptionTextAvailable, true);
    for (const [name, bytes] of Object.entries(bundle.files)) {
        const text = await fileText(name, bytes);
        assert.match(text, /Permission \[write\]/, name);
        assert.match(text, /source described moving/, name);
        assert.doesNotMatch(text, /EXCLUDED_OUTPUT_BODY|invented-tenant|invented-subject/, name);
    }
    assert.equal(JSON.stringify(frame), before);
});

test("returned API entries keep their own statuses, error copies and original positions across report comparison", async () => {
    const before = sourceRecord(null), after = sourceRecord(null);
    for (const [record, status] of [[before, 200], [after, 403]]) {
        record.toolCalls[0].resultEvidence.resultCount = 2;
        record.toolCalls[0].apiResults = resultMetadata(JSON.stringify({ results: [
            { status: 200, body: { value: [{ invented: 1 }, { invented: 2 }], "@odata.count": 91,
                "@odata.nextLink": "https://invented.invalid/next" } },
            { status, ...(status === 403 ? { error: { code: "AccessDenied", message: "Entry-specific permission is missing." } } : {}) },
        ] }));
    }
    const projection = record => projectReportResults([record], "a".repeat(64)).facts;
    const old = projection(before), current = projection(after);
    const comparison = compareReportResultFacts(old, current);
    assert.equal(comparison.shared.changedTypedFacts, 1);
    assert.equal(comparison.groups[0].applicationErrorDelta, null);
    assert.equal(current.calls[0].completion, "succeeded");
    assert.deepEqual(current.calls[0].observations[0].returnedEntries.map(entry => entry.statusCode), [200, 403]);
    assert.equal(current.calls[0].observations[0].resultCount, 2);
    assert.doesNotMatch(JSON.stringify(current), /odata|invented|Entry-specific/);
    assert.equal(current.calls[0].observations[0].returnedEntries[0].itemCount, undefined);
    const bundle = await buildSanitizedBundle([after], "a".repeat(64), { promptMode: "none", resultText: true, formats: ["json", "html", "markdown", "pdf"] });
    assert.equal(bundle.snapshot.resultText.copies[0].entryIndex, 1);
    for (const [name, bytes] of Object.entries(bundle.files)) {
        const text = await fileText(name, bytes);
        assert.match(text, /Entry-specific permission/, name);
        if (!name.endsWith(".json")) assert.match(text, /returned API entry 2|Returned API entry 2/, name);
    }
    const altered = structuredClone(current);
    altered.calls[0].observations[0].returnedEntries[1].index = 0;
    assert.throws(() => validateReportResultFacts(altered), /Invalid frozen result/);
});

test("segmented native Current report retains every original result observation through separate Save and authorized reopen", async t => {
    const source = coworkSourceContext();
    source.capture.parserVersion = COWORK_MATCHED_RESULT_ADAPTER_VERSION;
    const envelopes = adaptCoworkSourceRecordsWithResultFacts(["Permission [write] is required.", "A different recorded error."].map((err, index) =>
        sourceObservation({ id: `native-result-${index}`, event: "tx", data: { tid: "native-call", tn: "mcp__outlook__MoveMessage",
            ok: true, err, d: "The source described the attempted operation.", out: index ? "" : "EXCLUDED_NATIVE_BODY" } }, index)), source);
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const page = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 1, after: null } }, app.services.nativeReportAdmission);
    const services = { nativeReportSource: app.services.nativeReportSource, nativeReportAdmission: app.services.nativeReportAdmission,
        resolveNativeReportView: ({ kind, revision }) => views.resolveSelection({ schemaVersion: 1,
            viewId: page.viewId, nativeIds: [], kind, revision }, app.services.nativeReportAdmission) };
    const controller = createExportController(app.context);
    const preview = await controller.preview(app.owner, undefined, { promptMode: "none", resultText: true, formats: ["json", "html", "markdown", "pdf"] },
        { kind: "current", revision: page.revision, scenarioIds: [] }, undefined, services);
    const facts = preview.snapshot.resultFacts;
    assert.equal(facts.calls.length, 1);
    assert.equal(facts.calls[0].observations.length, 2);
    assert.deepEqual(facts.calls[0].observations.map(value => value.contentStatus).sort(), ["body-excluded", "recorded-empty"]);
    assert.ok(facts.calls[0].observations.every(value => value.applicationError === null && value.statusCode === null && value.resultCount === null));
    await assert.rejects(controller.confirm(app.owner, preview.previewId, true, undefined, services), /review/i);
    await controller.review(app.owner, preview.previewId, true, undefined, services);
    const saved = await controller.confirm(app.owner, preview.previewId, true, undefined, services);
    await assert.rejects(readSavedArtifactFile(app.context, await loadBoardState(app.context), saved.bundle.bundleId, "report", "json"), { status: 403 });
    await services.nativeReportSource.readSaved({ bundleIds: [saved.bundle.bundleId] }, services.nativeReportAdmission, async state => {
        for (const format of ["json", "html", "markdown", "pdf"]) {
            const artifact = await readSavedArtifactFile(app.context, state, saved.bundle.bundleId, "report", format);
            const text = await fileText(`report.${format === "markdown" ? "md" : format}`, artifact.bytes);
            assert.match(text, /Permission \[write\]/, format);
            assert.match(text, /different recorded error/, format);
            assert.doesNotMatch(text, /EXCLUDED_NATIVE_BODY/, format);
            if (format === "json") assert.deepEqual(JSON.parse(text).resultFacts, facts);
        }
    });

});

test("result-text size and count limits refuse rather than silently dropping disclosure copies", () => {
    for (const [count, message] of [[3001, "Recorded error detail."], [600, "Recorded error detail. ".repeat(350)]]) {
        const sources = Array.from({ length: count }, (_, index) => ({
            memberRef: "record-" + "a".repeat(32), observationRef: "result-observation-" + index.toString(16).padStart(16, "0"),
            source: "github-copilot", diagnostic: { version: 1, source: "completion-error", status: "recorded", message },
        }));
        assert.throws(() => projectReportResultText({ sources }, "a".repeat(64), { resultText: true }), /3000-copy or 4 MiB limit/);
        assert.equal(projectReportResultText({ sources }, "a".repeat(64), { resultText: false }), null);
    }
});
