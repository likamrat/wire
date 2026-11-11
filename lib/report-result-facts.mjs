import { createHash } from "node:crypto";
import { normalizeResultEvidence } from "./result-evidence.mjs";
import { retainedErrorDiagnostic } from "./failure-details.mjs";
import { REPORT_RESULT_TEXT_STATUSES as TEXT_STATUS, reportErrorCodeAllowed as codeAllowed,
    validateReportResultFacts, reportResultMemberRefs } from "./report-result-contract.mjs";
export * from "./report-result-contract.mjs";

export function projectReportResultObservation(observationRef, { resultEvidence, diagnostic, legacyFailure,
    callCompletion, interpretation, retainedResultCount = null, paginationPresent = null, returnedEntries = null } = {}) {
    const result = normalizeResultEvidence(resultEvidence);
    if (resultEvidence != null && !result) throw new TypeError("Unsupported retained result metadata; report preparation stopped.");
    const error = retainedErrorDiagnostic(diagnostic ?? result?.diagnostic);
    if (diagnostic != null && !error) throw new TypeError("Unsupported retained error metadata; report preparation stopped.");
    const legacy = !error && legacyFailure?.version === 1 ? legacyFailure : null;
    const code = error?.code ?? (legacy?.reason === "error-code-recorded" ? legacy.code : null);
    const legacyStatus = legacy?.messageStatus === "text-excluded" ? "not-retained"
        : TEXT_STATUS.includes(legacy?.messageStatus) ? legacy.messageStatus : null;
    return {
        ref: observationRef, resultVersion: result ? 1 : null, resultSource: result?.source ?? null,
        applicationError: result?.applicationError ?? null, statusCode: result?.statusCode ?? null,
        statusConflict: result?.statusConflict ?? null,
        resultCount: result?.resultCount ?? null, retainedResultCount, paginationPresent,
        returnedEntries: returnedEntries?.map(entry => {
            const diagnostic = retainedErrorDiagnostic(entry.errorDiagnostic), code = diagnostic?.code ?? entry.errorCode;
            const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
            return { index: entry.index, statusCode: Number.isInteger(entry.statusCode) && entry.statusCode >= 100 && entry.statusCode <= 599 ? entry.statusCode : null,
                ...(validStatus(entry.statusCode) && validStatus(diagnostic?.statusCode) && entry.statusCode !== diagnostic.statusCode
                    ? { statusConflict: { version: 1, reported: entry.statusCode, diagnostic: diagnostic.statusCode } } : {}),
                errorCode: codeAllowed(code) ? code : null, errorCodeStatus: code == null ? "not-supplied" : codeAllowed(code) ? "recorded" : "withheld",
                diagnosticStatus: diagnostic?.status ?? null, errorTextAvailable: diagnostic ? Boolean(diagnostic.message || diagnostic.details?.some(detail => detail.message)) : null,
                paginationPresent: entry.paginationPresent === true ? true : null };
        }) ?? null,
        contentStatus: result?.contentStatus ?? null,
        diagnosticStatus: error?.status ?? legacyStatus,
        errorTextAvailable: error ? Boolean(error.message || error.details?.some(detail => detail.message)) : legacyStatus ? false : null,
        errorCode: codeAllowed(code) ? code : null,
        errorCodeStatus: code == null ? "not-supplied" : codeAllowed(code) ? "recorded" : "withheld",
        errorCodeBasis: code == null ? null : error ? "diagnostic-field" : "retained-failure-projection",
        errorStatusCode: error?.statusCode ?? null,
        ...(interpretation?.items.length ? { interpretation: structuredClone(interpretation) } : {}),
        ...(callCompletion === "failed" && legacyFailure?.version === 1
            && legacyFailure.messageStatus === "text-excluded" && legacyFailure.messageSignal === "request-timeout"
            ? { timingFailure: { version: 1, kind: "request-timeout", basis: "retained-failure-signal" } } : {}),
        descriptionStatus: result?.description?.status ?? null,
        descriptionTextAvailable: result?.description ? Boolean(result.description.text) : null,
    };
}

export function inspectReportResultFacts(manifest, snapshot) {
    const present = Object.hasOwn(manifest, "resultFacts") || Object.hasOwn(manifest, "resultFactsHash")
        || snapshot && Object.hasOwn(snapshot, "resultFacts");
    if (!present) return null;
    const facts = validateReportResultFacts(manifest.resultFacts, { memberRefs: reportResultMemberRefs(manifest) });
    const namespace = (manifest.evaluationFacts ?? manifest.nativeEvidence?.githubEvaluationFacts)?.namespace?.ref;
    if (namespace && facts.namespace !== namespace || typeof manifest.resultFactsHash !== "string"
        || createHash("sha256").update(JSON.stringify(facts)).digest("hex") !== manifest.resultFactsHash
        || snapshot && JSON.stringify(snapshot.resultFacts) !== JSON.stringify(facts)) {
        throw new TypeError("Invalid frozen result facts.");
    }
    return facts;
}
