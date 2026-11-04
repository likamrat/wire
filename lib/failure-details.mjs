import { findTextFindings } from "./privacy-text.mjs";

const SOURCES = ["completion-error", "result-error", "workiq-error-json", "mcp-result-text", "native-tool-error"];
const EXCLUSIONS = ["not-supplied", "unsupported-format", "size-excluded", "sensitive-excluded"];
const LIMIT = 8192;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const code = value => Number.isSafeInteger(value) ? value
    : typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value)
        && !findTextFindings(value).length ? value : null;

export function screenResultText(value, remaining = LIMIT) {
    if (value == null || value === "") return { status: "not-supplied", cost: 0 };
    if (typeof value !== "string") return { status: "unsupported-format", cost: 0 };
    const bytes = Buffer.byteLength(value);
    if (bytes > remaining) return { status: "size-excluded", cost: 0 };
    const findings = findTextFindings(value);
    if (findings.some(finding => finding.mandatory || finding.category === "sensitivity_markings")) {
        return { status: "sensitive-excluded", cost: 0 };
    }
    if (/```|(?:^|\n)\s*(?:\{\s*(?:"[^"\r\n]*"\s*:|\})|\[\s*(?:"|\{|\[|-?\d|true\b|false\b|null\b|\]))|[{\[,]\s*"[^"\r\n]+"\s*:|\b(?:body|payload|response)\s*[:=]\s*[{[]|^\s*at\s+.+:\d+/im.test(value)) {
        return { status: "unsupported-format", cost: 0 };
    }
    const ranges = findings.sort((a, b) => a.start - b.start).reduce((ranges, item) => {
        const last = ranges.at(-1);
        if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
        else ranges.push({ start: item.start, end: item.end });
        return ranges;
    }, []);
    let text = "", offset = 0;
    for (const range of ranges) { text += value.slice(offset, range.start) + "[redacted]"; offset = range.end; }
    text += value.slice(offset);
    const cost = Math.max(bytes, Buffer.byteLength(text));
    if (cost > remaining) return { status: "size-excluded", cost: 0 };
    return { status: ranges.length ? "redacted" : "recorded", text, cost };
}

// Only explicitly typed error fields enter this projection. Never serialize the error/body/stack wholesale.
export function errorDiagnostic(error, source) {
    if (!SOURCES.includes(source)) return null;
    const base = { version: 1, source };
    if (error == null) return { ...base, status: "not-supplied" };
    if (typeof error === "string") error = { message: error };
    if (!object(error)) return { ...base, status: "unsupported-format" };
    let remaining = LIMIT, redacted = false, exclusion;
    function message(value) {
        const screened = screenResultText(value, remaining);
        if (screened.status === "not-supplied") return undefined;
        if (!["recorded", "redacted"].includes(screened.status)) {
            if (screened.status === "sensitive-excluded") exclusion = screened.status;
            else exclusion ??= screened.status;
            return undefined;
        }
        remaining -= screened.cost;
        redacted ||= screened.status === "redacted";
        return screened.text;
    }
    function fields(value) {
        const result = {};
        const safeCode = code(value.code), safeStatus = status(value.statusCode ?? value.status);
        if (safeCode !== null) result.code = safeCode;
        if (safeStatus !== null) result.statusCode = safeStatus;
        const text = message(value.message);
        if (text !== undefined) result.message = text;
        return result;
    }
    const result = fields(error);
    if (error.details != null) {
        if (!Array.isArray(error.details)) exclusion ??= "unsupported-format";
        else if (error.details.length > 10) exclusion ??= "size-excluded";
        else {
            if (error.details.some(value => !object(value))) exclusion ??= "unsupported-format";
            const details = error.details.filter(object).map(fields).filter(value => Object.keys(value).length);
            if (details.length) result.details = details;
        }
    }
    if (exclusion === "sensitive-excluded") {
        // Do not retain a partial quotation of credential-bearing or explicitly sensitive diagnostics.
        return { ...base, status: exclusion, ...(result.code !== undefined ? { code: result.code } : {}),
            ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}) };
    }
    return { ...base, status: exclusion ?? (Object.keys(result).length ? redacted ? "redacted" : "recorded" : "not-supplied"), ...result };
}

export function retainedErrorDiagnostic(value) {
    if (value?.version !== 1 || !SOURCES.includes(value.source)
        || !["recorded", "redacted", ...EXCLUSIONS].includes(value.status)) return null;
    const checked = errorDiagnostic(value.status === "sensitive-excluded"
        ? { code: value.code, statusCode: value.statusCode } : value, value.source);
    if (!checked) return null;
    if (EXCLUSIONS.includes(value.status) && ["recorded", "not-supplied"].includes(checked.status)) checked.status = value.status;
    else if (value.status === "redacted" && checked.status === "recorded") checked.status = "redacted";
    return checked;
}
