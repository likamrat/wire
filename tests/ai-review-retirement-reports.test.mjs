import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController, writeBundle } from "../lib/export.mjs";
import { buildReportFacts, assessmentHash } from "../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts, projectCurrentEvaluationFacts, adaptEvaluationReport } from "../lib/report-facts.mjs";
import { renderHtmlReport, renderMarkdownReport } from "../lib/product-report.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { inspectComparisonPair, buildComparisonBundle } from "../lib/comparison-export.mjs";
import { readSavedReportFile, readSavedReportDocument, readSavedComparison } from "../lib/report-artifacts.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { comparisonBodyHtml, renderComparisonHtml, renderComparisonMarkdown, reportPresentation } from "../lib/report-presentation.mjs";
import { exclusiveBoard, loadBoardState } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";
import { makeRatio } from "./report-comparison-fixtures.mjs";

function historicalFacts(state, projection) {
    const facts = structuredClone(buildReportFacts(state.evidence, state, { preparedAt: "2026-10-10T12:00:00.000Z" }).facts);
    if (projection === undefined) delete facts.metricProjectionVersion;
    else facts.metricProjectionVersion = projection;
    const assessments = projection === 3 ? state.personalEvaluation.feedback.records.map(item => item.assessment)
        : state.personalEvaluation.modelEvaluation.records[0].assessments;
    for (const [index, assessment] of assessments.entries()) {
        facts.assessments.push({ ...assessment, basis: facts.basis });
        facts.metrics.push({
            ...makeRatio(1), metricRef: "metric-" + String(index + 5).repeat(32),
            basis: facts.basis, dimension: assessment.dimension, origin: assessment.origin,
            checkId: assessment.checkId, ...(assessment.evaluator ? { evaluator: assessment.evaluator } : {}),
            eligibleUnitRefs: [assessment.interactionRef], coveredUnitRefs: [assessment.interactionRef],
            evidenceRefs: assessment.origin === "user-personal" ? [...assessment.evidenceRefs, assessment.assessmentRef] : assessment.evidenceRefs,
        });
    }
    if (projection === undefined) facts.metrics = facts.metrics.filter(metric => metric.definitionId !== "recorded-response-duration");
    return freezeEvaluationFacts(facts);
}

// Invented historical bytes are built once, before the retirement operations under test.
async function saveHistoricalFixture(context, state, projection, formats) {
    const bundle = await buildSanitizedBundle(state.evidence, state.pseudonymKey, { promptMode: "none", formats });
    const facts = historicalFacts(state, projection);
    bundle.snapshot.evaluationFacts = facts;
    bundle.snapshot.presentation = reportPresentation;
    bundle.privacy.reviewerConfirmed = true; bundle.privacy.confirmedAt = new Date().toISOString();
    bundle.previewHtml = renderHtmlReport(bundle.records, { snapshot: bundle.snapshot });
    if (formats.includes("html")) bundle.files["product-report.html"] = bundle.previewHtml;
    if (formats.includes("markdown")) bundle.files["product-report.md"] = renderMarkdownReport(bundle.records, { snapshot: bundle.snapshot });
    if (formats.includes("json")) bundle.files["product-report.json"] = JSON.stringify(bundle.snapshot, null, 2) + "\n";
    if (formats.includes("pdf")) bundle.files["product-report.pdf"] = await renderPdf(bundle.previewHtml);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    Object.assign(manifest, { presentation: reportPresentation, evaluationFacts: facts, evaluationFactsHash: assessmentHash(JSON.stringify(facts)),
        snapshotHash: assessmentHash(JSON.stringify(bundle.snapshot)), privacyReview: bundle.privacy,
        files: Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
            .map(([name, bytes]) => [name, { sha256: assessmentHash(bytes), bytes: Buffer.byteLength(bytes) }])) });
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    return exclusiveBoard(context, async (current, save) => {
        const entry = await writeBundle(context, bundle, current);
        current.exports.push(entry); current.revision++;
        await save(current);
        return { entry, facts, snapshot: bundle.snapshot, html: bundle.previewHtml };
    });
}

async function pdfText(file) {
    const task = getDocument({ data: new Uint8Array(await readFile(file)), useSystemFonts: true });
    try {
        const document = await task.promise, text = [];
        for (let page = 1; page <= document.numPages; page++) {
            text.push((await (await document.getPage(page)).getTextContent()).items.map(item => item.str ?? "").join(" "));
        }
        return text.join(" ");
    } finally { await task.destroy(); }
}

async function saveHistoricalComparison(context, old, projection = 2) {
    const currentPair = await inspectComparisonPair(context, await loadBoardState(context), old[0].entry.bundleId, old[1].entry.bundleId);
    const bundle = await buildComparisonBundle(currentPair, { formats: ["html", "pdf", "json", "markdown"] }, renderPdf);
    const envelopes = old.map(item => adaptEvaluationReport(item.facts, {
        bundleId: item.entry.bundleId, snapshotHash: item.entry.snapshotHash, disclosureReviewed: true,
    }));
    const comparison = compareFrozenReportFacts(...envelopes, { metricProjectionVersion: projection });
    assert.equal(comparison.metricProjectionVersion, projection);
    await assert.rejects(buildComparisonBundle({ ...currentPair, comparison }, {}, renderPdf), /current metric projection/);
    await assert.rejects(buildComparisonBundle({ ...currentPair, comparison: { ...comparison, metricProjectionVersion: 4, presentation: currentPair.comparison.presentation } }, {}, renderPdf),
        /rating lanes/);
    await assert.rejects(buildComparisonBundle({ ...currentPair, comparison: { ...currentPair.comparison, presentation: reportPresentation } }, {}, renderPdf),
        /presentation definitions without grading bands/);
    comparison.presentation = reportPresentation;
    bundle.comparison = comparison;
    bundle.snapshot.comparison = comparison;
    bundle.snapshot.presentation = reportPresentation;
    bundle.snapshot.sourceFacts = old.map(item => ({ report: { bundleId: item.entry.bundleId, snapshotHash: item.entry.snapshotHash },
        evaluationFacts: item.facts, legacyFacts: null }));
    bundle.privacy.reviewerConfirmed = true;
    bundle.privacy.confirmedAt = new Date().toISOString();
    bundle.previewHtml = renderComparisonHtml(comparison, bundle.snapshot);
    bundle.files["comparison-report.html"] = bundle.previewHtml;
    bundle.files["comparison-report.md"] = renderComparisonMarkdown(comparison, bundle.snapshot);
    bundle.files["comparison-report.json"] = JSON.stringify(bundle.snapshot, null, 2) + "\n";
    bundle.files["comparison-report.pdf"] = await renderPdf(bundle.previewHtml);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    Object.assign(manifest, { presentation: reportPresentation, comparison, sourceFacts: bundle.snapshot.sourceFacts, privacyReview: bundle.privacy,
        snapshotHash: assessmentHash(JSON.stringify(bundle.snapshot)), comparisonHash: assessmentHash(JSON.stringify(comparison)),
        sourceFactsHash: assessmentHash(JSON.stringify(bundle.snapshot.sourceFacts)),
        files: Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
            .map(([name, bytes]) => [name, { sha256: assessmentHash(bytes), bytes: Buffer.byteLength(bytes) }])) });
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    return exclusiveBoard(context, async (state, save) => {
        const entry = await writeBundle(context, bundle, state);
        state.exports.push(entry); state.revision++;
        await save(state);
        return { entry, comparison };
    });
}

test("new reports and both comparison orientations exclude retired reviews while all historical formats and definitions stay unchanged", { timeout: 60000 }, async t => {
    const cleanup = [], f = await retirementFixture({ after: action => cleanup.push(action) });
    let runtime;
    t.after(async () => { try { await runtime?.close(); } finally { for (const action of cleanup.reverse()) await action(); } });
    const original = await loadBoardState(f.context);
    const old = [
        await saveHistoricalFixture(f.context, original, 2, ["html", "pdf", "json", "markdown"]),
        await saveHistoricalFixture(f.context, original, undefined, ["json"]),
        await saveHistoricalFixture(f.context, original, 3, ["html", "pdf", "json", "markdown"]),
    ];
    const oldComparisons = [
        await saveHistoricalComparison(f.context, old.slice(0, 2)),
        await saveHistoricalComparison(f.context, [old[0], old[2]], 3),
    ];
    const historicalFiles = [...old, ...oldComparisons].flatMap(item => Object.values(item.entry.files));
    const beforeBytes = await Promise.all(historicalFiles.map(file => readFile(file)));
    const definitions = old.map(item => JSON.stringify(item.facts));
    assert.match(await pdfText(old[0].entry.files["product-report.pdf"]), /synthetic-quality-fixture/);
    assert.match(await pdfText(old[2].entry.files["product-report.pdf"]), /Personal feedback/);
    const failures = [];
    const forbidden = () => { failures.push("provider"); throw new Error("No provider for report preparation."); };
    const reports = createExportController(f.context);
    runtime = await startServer(f.context, reports, { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: forbidden, readSource: forbidden } });
    const state = await loadBoardState(f.context);
    const preview = await reports.preview("report-owner", undefined, { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] },
        { kind: "selected", revision: state.revision, scenarioIds: f.input.scenarioIds });
    assert.equal(preview.snapshot.schemaVersion, 3, "Report envelope version is independent of metric projection.");
    assert.equal(preview.snapshot.evaluationFacts.metricProjectionVersion, 4);
    assert.ok(preview.snapshot.evaluationFacts.metrics.every(metric => metric.origin === "automatic-local" && metric.dimension === "speed"));
    assert.deepEqual(preview.snapshot.evaluationFacts.assessments, []);
    assert.ok(preview.snapshot.evaluationFacts.recordedOutcomes.length > 0);
    for (const text of [preview.previewHtml, preview.files["product-report.md"], preview.files["product-report.json"],
        preview.files["coverage-and-redaction-manifest.json"]]) {
        assert.doesNotMatch(text, /model-assessed|user-personal|synthetic-quality-fixture|AI results|AI review|Quality results|unsupported-check|assessmentAttempts|reviewStatuses|Personal feedback|Your feedback|performanceBands|assessed-pass-share/);
    }
    await assert.rejects(reports.confirm("report-owner", preview.previewId, true), /review/i);
    await reports.review("report-owner", preview.previewId, true);
    const saved = (await reports.confirm("report-owner", preview.previewId, true)).bundle;
    assert.doesNotMatch(await pdfText(saved.files["product-report.pdf"]), /synthetic-quality-fixture|AI results|Quality results/);
    for (const historical of old) {
        const current = await loadBoardState(f.context);
        const json = await readSavedReportFile(f.context, current, historical.entry.bundleId, "json");
        assert.equal(JSON.stringify(json.snapshot.evaluationFacts), JSON.stringify(historical.facts));
        const regenerated = renderHtmlReport(json.snapshot.records, { snapshot: json.snapshot });
        assert.equal(regenerated, historical.html, "JSON-only historical display must use its saved interpretation.");
        for (const [left, right] of [[historical.entry.bundleId, saved.bundleId], [saved.bundleId, historical.entry.bundleId]]) {
            const pair = await inspectComparisonPair(f.context, current, left, right);
            assert.equal(pair.comparison.metricProjectionVersion, 4);
            assert.deepEqual(pair.sourceReports.map(item => item.bundleId), [left, right]);
            assert.ok(pair.comparison.metrics.every(item => [item.baseline, item.later].filter(Boolean)
                .every(fact => fact.metric === "speed" && fact.basis === "observed")));
            if (historical.facts.metricProjectionVersion === undefined) {
                assert.ok(pair.comparison.metrics.some(item => item.metric === "speed"
                    && ["baseline-metric-not-saved", "later-metric-not-saved"].includes(item.reason) && item.delta === null),
                "Missing historical timing remains explicitly one-sided, never zero.");
            }
            assert.doesNotMatch(JSON.stringify(pair.sourceFacts), /model-assessed|user-personal|synthetic-quality-fixture|assessmentAttempts|reviewStatuses/);
            const comparison = await reports.previewComparison("report-owner", left, right, { formats: ["html", "json", "markdown"] });
            assert.doesNotMatch(comparison.previewHtml, /AI results|synthetic-quality-fixture/);
            await reports.reviewComparison("report-owner", comparison.previewId, true);
            await reports.confirmComparison("report-owner", comparison.previewId, true);
        }
    }
    const html = await readSavedReportDocument(f.context, await loadBoardState(f.context), old[0].entry.bundleId);
    assert.equal(html.html, old[0].html);
    for (const oldComparison of oldComparisons) {
        const savedComparison = await readSavedComparison(f.context, await loadBoardState(f.context), oldComparison.entry.bundleId);
        assert.deepEqual(savedComparison.comparison, oldComparison.comparison);
    }
    await runtime.close();
    runtime = await startServer(f.context, createExportController(f.context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: forbidden, readSource: forbidden } });
    const afterBytes = await Promise.all(historicalFiles.map(file => readFile(file)));
    assert.deepEqual(afterBytes, beforeBytes);
    assert.deepEqual(old.map(item => JSON.stringify(item.facts)), definitions);
    assert.deepEqual((await loadBoardState(f.context)).personalEvaluation, original.personalEvaluation);
    assert.deepEqual(failures, []);
    if (process.env.WIRE_AI_REMOVAL_PROOFS) {
        await mkdir(process.env.WIRE_AI_REMOVAL_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_AI_REMOVAL_PROOFS, "historical-byte-preservation.json"), JSON.stringify({
            inventedFixtureOnly: true, byteIdenticalFiles: historicalFiles.map((file, index) => ({
                name: path.basename(file), beforeSha256: assessmentHash(beforeBytes[index]), afterSha256: assessmentHash(afterBytes[index]),
            })),
            frozenDefinitionHashes: definitions.map(assessmentHash), comparisonDefinitionHashes: oldComparisons.map(item => assessmentHash(JSON.stringify(item.comparison))),
            restartVerified: true, unknownBillingUnchanged: true, providerCalls: failures.length,
        }, null, 2));
    }
});

test("v4 rejects all rating facts while legacy absent, v2 and v3 projections keep their original definitions", async t => {
    const f = await retirementFixture(t), state = await loadBoardState(f.context);
    for (const version of [undefined, 2, 3]) {
        const legacy = historicalFacts(state, version), before = JSON.stringify(legacy);
        assert.doesNotThrow(() => freezeEvaluationFacts(legacy));
        assert.throws(() => freezeEvaluationFacts({ ...legacy, metricProjectionVersion: 4 }), /retired-review-facts/);
        const projected = projectCurrentEvaluationFacts(legacy);
        assert.equal(projected.metricProjectionVersion, 4);
        assert.deepEqual(projected.assessments, []);
        assert.ok(projected.metrics.every(metric => metric.dimension === "speed"));
        assert.equal(JSON.stringify(legacy), before);
    }
    const facts = structuredClone(historicalFacts(state, 3));
    for (const outcome of facts.recordedOutcomes) if (outcome.kind === "tool-call") outcome.outcome = "unknown";
    const sources = [1, 2].map(index => adaptEvaluationReport(facts, {
        bundleId: `export-${String(index).repeat(8)}-1111-4111-8111-111111111111`,
        snapshotHash: String(index).repeat(64), disclosureReviewed: true,
    }));
    const historical = comparisonBodyHtml(compareFrozenReportFacts(...sources, { metricProjectionVersion: 3 }));
    const current = comparisonBodyHtml(compareFrozenReportFacts(...sources, { metricProjectionVersion: 4 }));
    assert.match(historical, /Not scored/);
    assert.match(current, /No binary outcomes/);
    assert.doesNotMatch(current, /Not scored|Personal feedback/);
});
