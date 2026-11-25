import { retainedErrorDiagnostic, screenResultText } from "./failure-details.mjs";

const SOURCES = ["sdk-result", "native-tool-result"];
const CONTENT = ["not-supplied", "explicit-null", "recorded-empty", "body-excluded", "unsupported-format", "size-excluded", "partial"];
const status = value => value === null || Number.isInteger(value) && value >= 100 && value <= 599;
const count = value => value === null || Number.isSafeInteger(value) && value >= 0;

export function resultDescription(value) {
    if (value === undefined) return { version: 1, status: "not-supplied" };
    if (value === null) return { version: 1, status: "explicit-null" };
    if (value === "") return { version: 1, status: "recorded-empty", text: "" };
    const { status, text } = screenResultText(value);
    return { version: 1, status, ...(text !== undefined ? { text } : {}) };
}

export function normalizeResultDescription(value) {
    if (value?.version !== 1) return null;
    if (["not-supplied", "explicit-null", "unsupported-format", "size-excluded", "sensitive-excluded"].includes(value.status)) {
        return { version: 1, status: value.status };
    }
    if (!["recorded", "redacted", "recorded-empty"].includes(value.status) || typeof value.text !== "string") return null;
    const normalized = resultDescription(value.text);
    if (value.status === "redacted" && normalized.status === "recorded") normalized.status = "redacted";
    return normalized;
}

// Producers supply only source-qualified facts; this carrier never derives task or completion outcomes.
export function normalizeResultEvidence(value) {
    if (value?.version !== 1 || !SOURCES.includes(value.source) || !CONTENT.includes(value.contentStatus)
        || value.applicationError !== null && typeof value.applicationError !== "boolean"
        || !status(value.statusCode) || !count(value.resultCount)) return null;
    if (value.contentStatus === "partial" && (value.source !== "sdk-result" || value.resultCount !== null)) return null;
    const diagnostic = value.diagnostic === undefined ? undefined : retainedErrorDiagnostic(value.diagnostic);
    const description = value.description === undefined ? undefined : normalizeResultDescription(value.description);
    if (value.diagnostic !== undefined && !diagnostic) return null;
    if (value.description !== undefined && !description) return null;
    const conflict = value.statusConflict;
    if (conflict !== undefined && (value.source !== "sdk-result" || value.statusCode !== null
        || !Number.isInteger(conflict?.structured) || !status(conflict.structured)
        || !Number.isInteger(conflict?.text) || !status(conflict.text) || conflict.structured === conflict.text)) return null;
    return { version: 1, source: value.source, applicationError: value.applicationError,
        statusCode: value.statusCode, contentStatus: value.contentStatus, resultCount: value.resultCount,
        ...(diagnostic ? { diagnostic } : {}), ...(description ? { description } : {}),
        ...(conflict ? { statusConflict: { structured: conflict.structured, text: conflict.text } } : {}) };
}
