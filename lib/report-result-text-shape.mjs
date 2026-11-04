import { findTextFindings, TEXT_RULES } from "./privacy-text.mjs";
import { validateReportResultFacts, periodResultTextFacts } from "./report-result-facts.mjs";
import { createHash } from "node:crypto";
import { resultCohortFacts } from "./report-result-contract.mjs";

export const RESULT_TEXT_LIMITS = Object.freeze({ copies: 3000, bytes: 4 * 1024 * 1024 });
export const RESULT_TEXT_KINDS = Object.freeze(["error-message", "error-detail", "error-code", "source-description"]);
const representations = ["omitted", "unavailable", "edited-copy", "masked-copy"];
const statuses = ["recorded", "redacted", "recorded-empty", "not-supplied", "not-retained", "explicit-null",
    "unsupported-format", "size-excluded", "sensitive-excluded"];
const categories = new Set([...TEXT_RULES.map(([name]) => name), "manual"]);
function require(condition) { if (!condition) throw new TypeError("Invalid frozen result-text copies."); }
function shape(value, keys) {
    require(value && Object.getPrototypeOf(value) === Object.prototype && keys.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => keys.includes(key)));
}

export function resultTextCoverage(copies) {
    return { total: copies.length, included: copies.filter(copy => copy.text !== null).length,
        omitted: copies.filter(copy => copy.omitted).length, unavailable: copies.filter(copy => copy.status === "unavailable").length,
        edited: copies.filter(copy => copy.representation === "edited-copy").length,
        bytes: copies.reduce((sum, copy) => sum + Buffer.byteLength(copy.text ?? ""), 0) };
}

export function validateReportResultText(value, facts) {
    validateReportResultFacts(facts);
    shape(value, ["version", "mode", "copies", "coverage"]);
    require(value.version === 1 && value.mode === "masked" && Array.isArray(value.copies) && value.copies.length <= RESULT_TEXT_LIMITS.copies);
    const calls = new Map(facts.calls.map(call => [call.ref, call])), keys = new Set();
    for (const copy of value.copies) {
        shape(copy, ["key", "memberRefs", "observationRef", "source", "kind", "index", "entryIndex", "sourceStatus", "status",
            "label", "omitted", "representation", "text", "changes"]);
        require(typeof copy.key === "string" && /^result-copy-[a-f0-9]{16}$/.test(copy.key) && !keys.has(copy.key)
            && RESULT_TEXT_KINDS.includes(copy.kind) && Number.isSafeInteger(copy.index) && copy.index >= 0
            && statuses.includes(copy.sourceStatus) && ["full", "unavailable"].includes(copy.status)
            && typeof copy.omitted === "boolean" && representations.includes(copy.representation)
            && (copy.text === null || typeof copy.text === "string")
            && ["Recorded error", "Error detail", "Recorded error code", "Source description"].includes(copy.label)
            && Array.isArray(copy.memberRefs) && copy.memberRefs.length > 0 && new Set(copy.memberRefs).size === copy.memberRefs.length
            && copy.memberRefs.every(ref => calls.get(ref)?.source === copy.source
                && calls.get(ref).observations.some(observation => observation.ref === copy.observationRef
                    && (copy.entryIndex === null || Number.isInteger(copy.entryIndex)
                        && observation.returnedEntries?.some(entry => entry.index === copy.entryIndex)))));
        require((copy.representation === "omitted") === copy.omitted
            && (!copy.omitted && copy.status !== "unavailable" || copy.text === null)
            && (copy.text !== null || copy.omitted || copy.representation === "unavailable"));
        require(Array.isArray(copy.changes) && copy.changes.every(change => change && Object.keys(change).length === 2
            && categories.has(change.category) && typeof change.mandatory === "boolean"));
        if (copy.text !== null) require(!findTextFindings(copy.text).some(finding => finding.category !== "sensitivity_markings"));
        keys.add(copy.key);
    }

    require(JSON.stringify(value.coverage) === JSON.stringify(resultTextCoverage(value.copies))
        && value.coverage.bytes <= RESULT_TEXT_LIMITS.bytes);
    return value;
}

export function inspectReportResultText(manifest, snapshot, facts) {
    if (manifest.resultText === undefined && manifest.resultTextHash === undefined && snapshot?.resultText === undefined) return null;
    facts ??= manifest.resultFacts ?? (manifest.periodComparison ? periodResultTextFacts(manifest.periodComparison) : undefined);
    const value = validateReportResultText(manifest.resultText, facts);
    require(createHash("sha256").update(JSON.stringify(value)).digest("hex") === manifest.resultTextHash);
    if (snapshot) require(JSON.stringify(value) === JSON.stringify(snapshot.resultText));
    return value;
}

export function validateComparisonResultText(value, sources, comparison) {
    shape(value, ["version", "mode", "cohort", "sources"]);
    require(value.version === 1 && value.mode === "masked" && value.cohort === comparison.resultComparison?.cohort
        && Array.isArray(sources) && sources.length === 2 && Array.isArray(value.sources) && value.sources.length === 2);
    const selected = resultCohortFacts(sources[0].resultFacts, sources[1].resultFacts, value.cohort, comparison);
    let copies = 0, bytes = 0;
    for (const [index, source] of value.sources.entries()) {
        shape(source, ["report", "resultText", "reason", ...(Object.hasOwn(source, "unavailableSources") ? ["unavailableSources"] : [])]);
        require(JSON.stringify(source.report) === JSON.stringify(sources[index].report));
        const facts = selected?.[index ? "later" : "baseline"];
        const unavailable = selected?.unavailableSources[index ? "later" : "baseline"] ?? [];
        const unqualified = !facts || unavailable.length > 0 && facts.calls.length === 0;
        if (source.resultText === null) require(source.reason === (unqualified ? "cohort-unqualified" : "not-in-source-report") && source.unavailableSources === undefined);
        else {
            require(source.reason === null && facts);
            require(JSON.stringify(source.unavailableSources ?? []) === JSON.stringify(unavailable)
                && (!unavailable.length || facts.calls.length > 0));
            validateReportResultText(source.resultText, facts);
            copies += source.resultText.coverage.total; bytes += source.resultText.coverage.bytes;
        }
    }
    require(copies <= RESULT_TEXT_LIMITS.copies && bytes <= RESULT_TEXT_LIMITS.bytes);
    return value;
}
