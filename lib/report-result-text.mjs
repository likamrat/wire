import { projectReportCopy } from "./prompt-projection.mjs";
import { reportContextRef } from "./report-ref.mjs";
import { retainedErrorDiagnostic, errorDiagnostic } from "./failure-details.mjs";
import { normalizeResultEvidence } from "./result-evidence.mjs";
import { BoardError } from "./store.mjs";
import { RESULT_TEXT_LIMITS, resultTextCoverage, validateReportResultText } from "./report-result-text-shape.mjs";
import { resultCohortFacts } from "./report-result-contract.mjs";

export function projectReportResultText(projection, key, options) {
    if (options.resultText !== true) return null;
    const entries = new Map();
    let bytes = 0;
    function add(source, kind, index, label, original, sourceStatus, entryIndex = null, channel = null) {
        const identity = [source.observationRef, entryIndex, kind, index];
        if (channel) identity.push(channel);
        const copyKey = reportContextRef(key, "result-copy", JSON.stringify(identity));
        const existing = entries.get(copyKey);
        if (existing) {
            if (existing.original !== original || existing.source !== source.source || existing.sourceStatus !== sourceStatus) {
                throw new BoardError("Retained result-text variants conflict. Narrow the selection; no text was substituted.", 422);
            }
            if (!existing.memberRefs.includes(source.memberRef)) existing.memberRefs.push(source.memberRef);
            return;
        }
        bytes += Buffer.byteLength(original ?? "");
        if (entries.size >= RESULT_TEXT_LIMITS.copies || bytes > RESULT_TEXT_LIMITS.bytes) {
            throw new BoardError("Result-text copies exceed the 3000-copy or 4 MiB limit. Narrow the report or turn off result text.", 422);
        }
        entries.set(copyKey, { key: copyKey, memberRefs: [source.memberRef], observationRef: source.observationRef,
            source: source.source, kind, index, entryIndex, label, original, sourceStatus,
            status: original === null ? "unavailable" : "full" });
    }
    for (const source of projection.sources) {
        const result = normalizeResultEvidence(source.resultEvidence);
        const diagnostic = retainedErrorDiagnostic(source.diagnostic ?? result?.diagnostic);
        function addDiagnostic(value, entryIndex = null, channel = null) {
            add(source, "error-message", 0, channel ? "Recorded result error" : "Recorded error", value.message ?? null, value.status, entryIndex, channel);
            for (const [index, detail] of (value.details ?? []).entries()) {
                if (detail.message) add(source, "error-detail", index, channel ? "Result error detail" : "Error detail", detail.message, value.status, entryIndex, channel);
                if (detail.code != null) add(source, "error-code", index + 1, channel ? "Recorded result error code" : "Recorded error code", String(detail.code), value.status, entryIndex, channel);
            }
            if (value.code != null) add(source, "error-code", 0, channel ? "Recorded result error code" : "Recorded error code", String(value.code), value.status, entryIndex, channel);
        }
        if (diagnostic) {
            addDiagnostic(diagnostic);
        } else if (source.legacyFailure?.version === 1 && source.legacyFailure.reason === "error-code-recorded") {
            const screened = errorDiagnostic({ code: source.legacyFailure.code }, "completion-error");
            if (screened.code != null) add(source, "error-code", 0, "Recorded error code", String(screened.code), "not-retained");
        }
        if (source.diagnostic && result?.diagnostic
            && JSON.stringify(diagnostic) !== JSON.stringify(result.diagnostic)) addDiagnostic(result.diagnostic, null, "result-error");
        if (result?.description && options.resultTextKind !== "errors") {
            add(source, "source-description", 0, "Source description", result.description.text || null, result.description.status);
        }
        for (const entry of source.returnedEntries ?? []) {
            const diagnostic = retainedErrorDiagnostic(entry.errorDiagnostic);
            if (diagnostic) addDiagnostic(diagnostic, entry.index);
        }
    }
    const masked = { ...options, promptMode: "masked" };
    const review = [...entries.values()].map(entry => projectReportCopy(entry, masked));
    const copies = review.map(({ original, segments, edited, ...copy }) => copy);
    const frozen = validateReportResultText({ version: 1, mode: "masked", copies, coverage: resultTextCoverage(copies) }, projection.facts);
    return { frozen, review };
}

export function projectComparisonResultText(loaded, options, comparison) {
    if (options.resultText !== true) return null;
    if (comparison?.schemaVersion !== 1) throw new TypeError("Saved result copies require a source-qualified comparison.");
    const selected = resultCohortFacts(loaded[0].resultFacts, loaded[1].resultFacts, options.cohort, comparison);
    let copies = 0, bytes = 0;
    const sources = loaded.map((source, index) => {
        const facts = selected?.[index ? "later" : "baseline"];
        if (!selected || !facts) return { report: source.reference, resultText: null, reason: "cohort-unqualified" };
        const unavailableSources = selected.unavailableSources[index ? "later" : "baseline"];
        if (unavailableSources.length && !facts.calls.length) return { report: source.reference, resultText: null, reason: "cohort-unqualified" };
        if (!source.resultText) return { report: source.reference, resultText: null, reason: "not-in-source-report" };
        const members = new Set(facts.calls.map(call => call.ref));
        const projected = source.resultText.copies.flatMap(copy => {
            const memberRefs = copy.memberRefs.filter(ref => members.has(ref));
            if (!memberRefs.length) return [];
            const next = structuredClone({ ...copy, memberRefs });
            if (copy.text !== null) {
                const masked = projectReportCopy({ ...copy, original: copy.text }, { ...options, promptMode: "masked", overrides: [] });
                next.text = masked.text;
                next.changes.push(...masked.changes);
            }
            copies++; bytes += Buffer.byteLength(next.text ?? "");
            return [next];
        });
        const resultText = validateReportResultText({ version: 1, mode: "masked", copies: projected, coverage: resultTextCoverage(projected) }, facts);
        return { report: source.reference, resultText, reason: null, ...(unavailableSources.length ? { unavailableSources } : {}) };
    });
    if (copies > RESULT_TEXT_LIMITS.copies || bytes > RESULT_TEXT_LIMITS.bytes) throw new BoardError("Comparison result text exceeds the copy limit. Turn off result text or use smaller source reports.", 422);
    return { version: 1, mode: "masked", cohort: options.cohort, sources };
}
