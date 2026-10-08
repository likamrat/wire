import { randomUUID } from "node:crypto";
import { BoardError } from "./store.mjs";
import { normalizeReportOptions } from "./prompt-projection.mjs";
import { time } from "./time.mjs";
import { scanReportMetadata, assertProjectedBundle } from "./privacy.mjs";
import { compareFrozenReportFacts } from "./frozen-report-comparison.mjs";
import { verifiedReportIdentityRelation } from "./wire-report-snapshot-adapter.mjs";
import { loadSavedReportSource, savedArtifact, describeSavedArtifact, reportHash, readSavedComparison } from "./report-artifacts.mjs";
import { evaluationGeneratedHashes, projectCurrentEvaluationFacts } from "./report-facts.mjs";
import { renderComparisonHtml, renderComparisonMarkdown, reportPresentation } from "./report-presentation.mjs";

export function normalizeComparisonOptions(input = {}) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).some(key => !["formats", "timeContext", "cohort"].includes(key))) {
        throw new BoardError("Choose comparison formats and a supported cohort.", 422);
    }
    const cohort = input.cohort ?? "snapshots";
    if (!["snapshots", "non-overlapping", "later-additions"].includes(cohort)) throw new BoardError("Unsupported comparison cohort.", 422);
    return { ...normalizeReportOptions({ promptMode: "none", formats: input.formats ?? ["html"], timeContext: input.timeContext }), cohort };
}
export async function inspectComparisonPair(session, state, baselineId, laterId, options = {}) {
    if (baselineId === laterId) throw new BoardError("Choose two different saved reports.", 422);
    const settings = normalizeComparisonOptions(options);
    const loaded = await Promise.all([loadSavedReportSource(session, state, baselineId), loadSavedReportSource(session, state, laterId)]);
    const identityRelation = verifiedReportIdentityRelation(loaded[0].envelope, loaded[1].envelope, {
        namespaceProvenanceVerified: loaded.every(source => source.namespaceProvenanceVerified),
    });
    const comparison = compareFrozenReportFacts(loaded[0].envelope, loaded[1].envelope, { cohort: settings.cohort, identityRelation });
    comparison.presentation = reportPresentation;
    return {
        comparison,
        sources: loaded.map(source => describeSavedArtifact(savedArtifact(state, source.reference.bundleId), state)),
        dependencies: loaded.map(source => source.dependency),
        sourceReports: loaded.map(source => source.reference),
        sourceFacts: loaded.map(source => ({
            report: source.reference,
            evaluationFacts: source.facts ? projectCurrentEvaluationFacts(source.facts) : null,
            legacyFacts: source.facts ? null : source.envelope,
        })),
    };
}
export function comparisonGeneratedHashes(snapshot) {
    const hashes = [];
    for (const source of snapshot.sourceReports ?? []) hashes.push(source.snapshotHash, source.bundleId.replace(/^export-/, ""));
    for (const source of snapshot.sourceFacts ?? []) if (source.evaluationFacts) hashes.push(...evaluationGeneratedHashes(source.evaluationFacts));
    return hashes;
}
export async function buildComparisonBundle(pair, input, pdfRenderer) {
    const options = normalizeComparisonOptions(input), bundleId = `export-${randomUUID()}`, preparedAt = new Date().toISOString();
    const promptCoverage = { total: 0, included: 0, omitted: 0, partial: 0, unavailable: 0, edited: 0, mandatoryRemovals: 0, changes: 0 };
    const snapshot = {
        schemaVersion: 3, kind: "comparison", bundleId, preparedAt, promptMode: "none", formats: options.formats,
        timeContext: options.timeContext, preparedAtDisplay: time.formatTime(preparedAt, options.timeContext),
        dateSelection: options.dateSelection, dateRange: time.range(options.dateSelection, options.timeContext.timeZone),
        records: [], promptCoverage, coverage: { sourceReports: 2 }, presentation: reportPresentation,
        sourceReports: pair.sourceReports, sourceFacts: pair.sourceFacts, comparison: pair.comparison,
    };
    const generated = new Set(comparisonGeneratedHashes(snapshot));
    const scan = scanReportMetadata({ sourceFacts: snapshot.sourceFacts, comparison: snapshot.comparison }, generated);
    if (Object.entries(scan.categories).some(([category, count]) => count && category !== "sensitivity_markings")) {
        throw new BoardError("Projected comparison contains blocked private metadata. Nothing exported.", 422);
    }
    const privacy = {
        ...scan, allSelectedFieldsScanned: true, promptMode: "none",
        inputFingerprint: reportHash(JSON.stringify([snapshot.sourceReports, snapshot.sourceFacts, options])),
        reviewerConfirmed: false, reviewerIdentityVerified: false,
        scope: "Selected approved frozen report facts only; no source answers or prompt text.",
    };
    const previewHtml = renderComparisonHtml(pair.comparison, snapshot), files = {};
    if (options.formats.includes("html")) files["comparison-report.html"] = previewHtml;
    if (options.formats.includes("json")) files["comparison-report.json"] = JSON.stringify(snapshot, null, 2) + "\n";
    if (options.formats.includes("markdown")) files["comparison-report.md"] = renderComparisonMarkdown(pair.comparison, snapshot);
    const manifest = {
        schemaVersion: 3, kind: "comparison", bundleId, preparedAt, promptMode: "none", formats: options.formats,
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
        kind: "comparison", bundleId, preparedAt, records: [], snapshot, comparison: pair.comparison,
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
    return bundle;
}
export const openSavedComparison = readSavedComparison;
