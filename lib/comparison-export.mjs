import { randomUUID } from "node:crypto";
import { BoardError } from "./store.mjs";
import { normalizeReportOptions, projectReportTitle } from "./prompt-projection.mjs";
import { reportIdentity } from "./report-identity.mjs";
import { time } from "./time.mjs";
import { scanReportMetadata, assertProjectedBundle } from "./privacy.mjs";
import { compareFrozenReportFacts, nativeComparisonEvidence } from "./frozen-report-comparison.mjs";
import { verifiedReportIdentityRelation } from "./wire-report-snapshot-adapter.mjs";
import { loadSavedReportSource, savedArtifact, describeSavedArtifact, reportHash, readSavedComparison, SAVED_REPORT_MAX_BYTES } from "./report-artifacts.mjs";
import { evaluationGeneratedHashes, projectCurrentEvaluationFacts, validateReportEndpoint } from "./report-facts.mjs";
import { validateReportFacts } from "./assessment-contract.mjs";
import { renderComparisonHtml, renderComparisonMarkdown, currentReportPresentation as reportPresentation } from "./report-presentation.mjs";
import { validateReportResultFacts } from "./report-result-facts.mjs";
import { projectComparisonResultText } from "./report-result-text.mjs";
import { validateComparisonResultText } from "./report-result-text-shape.mjs";
import { reportLocalSaveRequest } from "./report-save-consent.mjs";

export function normalizeComparisonOptions(input = {}) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).some(key => !["title", "formats", "timeContext", "cohort", "resultText", "manualTerms", "saveMode"].includes(key))) {
        throw new BoardError("Choose comparison formats and a supported cohort.", 422);
    }
    const cohort = input.cohort ?? "snapshots";
    if (!["snapshots", "non-overlapping", "later-additions"].includes(cohort)) throw new BoardError("Unsupported comparison cohort.", 422);
    return { ...normalizeReportOptions({ title: input.title, promptMode: "none", formats: input.formats ?? ["html"],
        timeContext: input.timeContext, resultText: input.resultText, manualTerms: input.manualTerms, saveMode: input.saveMode }), cohort };
}
export async function inspectComparisonPair(session, state, baselineId, laterId, options = {}) {
    if (baselineId === laterId) throw new BoardError("Choose two different saved reports.", 422);
    const settings = normalizeComparisonOptions(options);
    const loaded = await Promise.all([loadSavedReportSource(session, state, baselineId), loadSavedReportSource(session, state, laterId)]);
    const identityRelation = verifiedReportIdentityRelation(loaded[0].envelope, loaded[1].envelope, {
        namespaceProvenanceVerified: loaded.every(source => source.namespaceProvenanceVerified),
    });
    const comparison = compareFrozenReportFacts(loaded[0].envelope, loaded[1].envelope, {
        cohort: settings.cohort, identityRelation, metricProjectionVersion: 4, resultProjectionVersion: 1 });
    comparison.presentation = reportPresentation;
    const resultTextSources = projectComparisonResultText(loaded, settings, comparison);
    if (resultTextSources) comparison.resultTextSources = resultTextSources;
    return {
        comparison,
        sources: loaded.map(source => describeSavedArtifact(savedArtifact(state, source.reference.bundleId), state)),
        dependencies: loaded.map(source => source.dependency),
        sourceReports: loaded.map(source => source.reference),
        sourceFacts: loaded.map(source => {
            const { resultFacts, ...envelope } = source.envelope;
            return { report: source.reference, resultFacts: source.resultFacts ?? null,
                evaluationFacts: source.facts ? projectCurrentEvaluationFacts(source.facts) : null,
                legacyFacts: source.facts ? null : source.nativeEvidence
                    ? { ...envelope, nativeEvidence: nativeComparisonEvidence(source.nativeEvidence) } : envelope };
        }),
    };
}
export function comparisonGeneratedHashes(snapshot) {
    const hashes = [];
    for (const source of snapshot.sourceReports ?? []) hashes.push(source.snapshotHash, source.bundleId.replace(/^export-/, ""));
    for (const source of snapshot.sourceFacts ?? []) if (source.evaluationFacts) hashes.push(...evaluationGeneratedHashes(source.evaluationFacts));
    for (const source of snapshot.sourceFacts ?? []) {
        const evidence = source.legacyFacts?.nativeEvidence;
        if (evidence?.githubEvaluationFacts) hashes.push(evidence.githubEvaluationFactsHash, ...evaluationGeneratedHashes(evidence.githubEvaluationFacts));
    }
    return hashes;
}
export async function buildComparisonBundle(pair, input, pdfRenderer) {
    if (pair?.comparison?.metricProjectionVersion !== 4) throw new BoardError("New comparisons require the current metric projection. Open historical saved files without regenerating them.", 422);
    if (JSON.stringify(pair.comparison.presentation) !== JSON.stringify(reportPresentation)) {
        throw new BoardError("New comparisons require current presentation definitions without grading bands.", 422);
    }
    if (!Array.isArray(pair.comparison.metrics) || pair.comparison.metrics.some(metric => {
        const sides = [metric.baseline, metric.later].filter(Boolean);
        return metric.metric !== "speed" || !sides.length || sides.some(fact => fact.metric !== "speed" || fact.basis !== "observed" || fact.kind !== "duration");
    }) || !Array.isArray(pair.sourceFacts) || pair.sourceFacts.length !== 2) {
        throw new BoardError("New comparisons cannot contain rating lanes or unverified source facts.", 422);
    }
    for (const source of pair.sourceFacts) {
        if (source.resultFacts) validateReportResultFacts(source.resultFacts);
        if (source.evaluationFacts) {
            if (source.evaluationFacts.metricProjectionVersion !== 4) throw new BoardError("New comparison source facts require the current metric projection.", 422);
            validateReportFacts(source.evaluationFacts, { validateEndpoint: validateReportEndpoint });
        } else if (source.legacyFacts?.nativeEvidence) {
            const evidence = nativeComparisonEvidence(source.legacyFacts.nativeEvidence);
            if (JSON.stringify(evidence) !== JSON.stringify(source.legacyFacts.nativeEvidence)) {
                throw new BoardError("Comparison facts must omit all Microsoft report text.", 422);
            }
        } else if (!Array.isArray(source.legacyFacts?.metrics) || source.legacyFacts.metrics.length) {
            throw new BoardError("Older comparison sources must use the supported recorded-outcome projection.", 422);
        }
    }
    const options = normalizeComparisonOptions(input), bundleId = `export-${randomUUID()}`, preparedAt = new Date().toISOString();
    if (Boolean(pair.comparison.resultTextSources) !== (options.resultText === true)) throw new BoardError("Result-text choices changed. Prepare this comparison again.", 409);
    if (pair.comparison.resultTextSources) validateComparisonResultText(pair.comparison.resultTextSources, pair.sourceFacts, pair.comparison);
    const title = projectReportTitle(options.title || reportIdentity.defaultTitle({ kind: "comparison" }), options);
    const promptCoverage = { total: 0, included: 0, omitted: 0, partial: 0, unavailable: 0, edited: 0, mandatoryRemovals: 0, changes: 0 };
    const snapshot = {
        schemaVersion: 3, kind: "comparison", bundleId, title: title.text, preparedAt, promptMode: "none", formats: options.formats,
        ...(options.saveMode === "local" ? { savePolicy: "local-save-v1" } : {}),
        timeContext: options.timeContext, preparedAtDisplay: time.formatTime(preparedAt, options.timeContext),
        dateSelection: options.dateSelection, dateRange: time.range(options.dateSelection, options.timeContext.timeZone),
        records: [], promptCoverage, coverage: { sourceReports: 2 }, presentation: reportPresentation,
        sourceReports: pair.sourceReports, sourceFacts: pair.sourceFacts, comparison: pair.comparison,
    };
    const generated = new Set(comparisonGeneratedHashes(snapshot));
    const scan = scanReportMetadata({ title: snapshot.title, sourceFacts: snapshot.sourceFacts, comparison: snapshot.comparison }, generated);
    if (Object.entries(scan.categories).some(([category, count]) => count && category !== "sensitivity_markings")) {
        throw new BoardError("Projected comparison contains blocked private metadata. Nothing exported.", 422);
    }
    const { manualTerms, ...publicOptions } = options;
    const privacy = {
        ...scan, allSelectedFieldsScanned: true, promptMode: "none",
        inputFingerprint: reportHash(JSON.stringify([snapshot.sourceReports, snapshot.sourceFacts, snapshot.comparison.resultTextSources ?? null,
            { ...publicOptions, title: snapshot.title }])),
        reportTitle: { ...title.scan, changes: title.changes },
        reviewerConfirmed: false, reviewerIdentityVerified: false,
        scope: options.resultText ? "Selected approved frozen report facts and separately chosen masked result-text copies; no original-source reads or prompt text."
            : "Selected approved frozen report facts only; no source answers or prompt text.",
    };
    const previewHtml = renderComparisonHtml(pair.comparison, snapshot), files = {};
    if (options.formats.includes("html")) files["comparison-report.html"] = previewHtml;
    if (options.formats.includes("json")) files["comparison-report.json"] = JSON.stringify(snapshot, null, 2) + "\n";
    if (options.formats.includes("markdown")) files["comparison-report.md"] = renderComparisonMarkdown(pair.comparison, snapshot);
    const manifest = {
        schemaVersion: 3, kind: "comparison", bundleId, title: snapshot.title, preparedAt, promptMode: "none", formats: options.formats,
        ...(snapshot.savePolicy ? { savePolicy: snapshot.savePolicy } : {}),
        timeContext: snapshot.timeContext, preparedAtDisplay: snapshot.preparedAtDisplay,
        dateSelection: snapshot.dateSelection, dateRange: snapshot.dateRange,
        snapshotHash: reportHash(JSON.stringify(snapshot)), snapshot: snapshot.coverage, promptCoverage, privacyReview: privacy, presentation: reportPresentation,
        sourceReports: snapshot.sourceReports, sourceFacts: snapshot.sourceFacts,
        comparison: snapshot.comparison, comparisonHash: reportHash(JSON.stringify(snapshot.comparison)),
        sourceFactsHash: reportHash(JSON.stringify(snapshot.sourceFacts)),
        retention: "Saved comparison exports retain their reviewed copies after source activity or an original report is deleted. Delete this saved comparison to remove its managed copies.",
        files: {},
    };
    const bundle = {
        kind: "comparison", bundleId, title: snapshot.title, preparedAt, records: [], snapshot, comparison: pair.comparison,
        promptReview: [], promptMode: "none", formats: options.formats, timeContext: snapshot.timeContext,
        privacy, previewHtml, files,
    };
    const update = () => {
        manifest.files = Object.fromEntries(Object.entries(files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
            .map(([name, bytes]) => [name, { sha256: reportHash(bytes), bytes: Buffer.byteLength(bytes) }]));
        files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    };
    update();
    assertProjectedBundle(bundle, { pendingPdf: true });
    if (options.formats.includes("pdf")) files["comparison-report.pdf"] = await pdfRenderer(previewHtml);
    update();
    bundle.projectionScan = assertProjectedBundle(bundle);
    if (Object.values(files).some(bytes => Buffer.byteLength(bytes) > SAVED_REPORT_MAX_BYTES)) {
        throw new BoardError("This comparison exceeds the supported saved-file size. Omit result text or use smaller source reports; no files were saved.", 422);
    }
    if (options.saveMode === "local") bundle.localSaveRequest = reportLocalSaveRequest(manifest);
    return bundle;
}
export const openSavedComparison = readSavedComparison;
