import { BoardError } from "./store.mjs";
import { textFindings, retainedPromptStatus, scanTree } from "./privacy.mjs";
import { time } from "./time.mjs";
import { promptAuthorship, promptAvailabilityFields } from "./prompt-authorship.mjs";

export const PROMPT_MODES = Object.freeze(["none", "masked", "original"]);
export const REPORT_FORMATS = Object.freeze(["html", "pdf", "json", "markdown"]);
export const MODE_LABELS = Object.freeze({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" });
const labels = {
    credentials: "credential removed", credential_assignments: "credential removed", credential_urls: "credential URL removed", private_keys: "private key removed",
    email_identifiers: "email identifier removed", phone_numbers: "phone number removed", street_addresses: "street address removed",
    labeled_person_identifiers: "person identifier removed", local_paths: "local path removed", private_urls: "URL removed",
    opaque_identifiers: "identifier removed", manual: "manual redaction",
};
const plainObject = (v) => v && Object.getPrototypeOf(v) === Object.prototype;

export function normalizeReportOptions(input = {}) {
    const invalid = () => { throw new BoardError("Choose a prompt mode and at least one supported report format. Redaction edits must be bounded text for a current prompt.", 422); };
    if (!plainObject(input) || Object.keys(input).some((k) => !["title", "promptMode", "formats", "manualTerms", "overrides", "timeContext", "dateSelection", "recordedContext", "resultText"].includes(k))) invalid();
    if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 200 || /[\u0000-\u001f\u007f]/.test(input.title))) {
        throw new BoardError("Use a report title of up to 200 characters on one line.", 422);
    }
    const { promptMode = "masked", formats = ["html"], manualTerms = [], overrides = [] } = input;
    if (!PROMPT_MODES.includes(promptMode) || !Array.isArray(formats) || !formats.length || formats.length > 4 || new Set(formats).size !== formats.length || formats.some((v) => !REPORT_FORMATS.includes(v))) invalid();
    if (!Array.isArray(manualTerms) || manualTerms.length > 100 || manualTerms.some((v) => typeof v !== "string" || !v.trim() || v.length > 1000)) invalid();
    if (!Array.isArray(overrides) || overrides.length > 3000 || new Set(overrides.map((v) => v?.key)).size !== overrides.length) invalid();
    if (input.recordedContext !== undefined && typeof input.recordedContext !== "boolean") invalid();
    if (input.resultText !== undefined && typeof input.resultText !== "boolean") invalid();
    for (const edit of overrides) if (!plainObject(edit) || Object.keys(edit).some((k) => !["key", "text", "omit"].includes(k)) || typeof edit.key !== "string" || edit.key.length > 200 || edit.text !== undefined && typeof edit.text !== "string" || edit.omit !== undefined && typeof edit.omit !== "boolean") invalid();
    if (Buffer.byteLength(JSON.stringify({ manualTerms, overrides })) > 4 * 1024 * 1024) invalid();
    let timeContext, dateSelection;
    try {
        timeContext = time.normalize(input.timeContext);
        dateSelection = time.selection(input.dateSelection);
        time.range(dateSelection, timeContext.timeZone);
    } catch (error) { throw new BoardError("Invalid report time context or date selection: " + error.message, 422); }
    return { ...(input.title?.trim() ? { title: input.title.trim() } : {}), promptMode, formats: REPORT_FORMATS.filter((f) => formats.includes(f)), manualTerms: [...manualTerms], overrides: structuredClone(overrides), timeContext, dateSelection,
        recordedContext: input.recordedContext === true && promptMode !== "none", ...(input.resultText === true ? { resultText: true } : {}) };
}

function mask(text, mode, terms) {
    const matches = textFindings(text).filter((f) => f.mandatory || mode === "masked" && f.category !== "sensitivity_markings");
    for (const term of terms) {
        const literal = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
        for (const match of text.matchAll(literal)) {
            matches.push({ start: match.index, end: match.index + match[0].length, category: "manual", mandatory: false });
        }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const ranges = [];
    for (const item of matches) {
        const last = ranges.at(-1);
        if (last && item.start < last.end) {
            last.end = Math.max(last.end, item.end);
            if (item.mandatory) { last.category = item.category; last.mandatory = true; }
        } else ranges.push({ ...item });
    }
    const segments = [];
    let cursor = 0;
    for (const item of ranges) {
        if (item.start > cursor) segments.push({ text: text.slice(cursor, item.start) });
        segments.push({ text: `[${labels[item.category]}]`, category: item.category, mandatory: item.mandatory });
        cursor = item.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor) });
    return { text: segments.map((s) => s.text).join(""), segments, changes: ranges.map(({ category, mandatory }) => ({ category, mandatory })) };
}

export function projectReportTitle(title, options) {
    return { ...mask(title, "masked", options.manualTerms), scan: { ...scanTree({ title }), allTitleFieldsScanned: true } };
}

function sourcePrompts(scenario, id) {
    const result = [];
    const add = (suffix, kind, label, text, status = "full") => {
        const effectiveStatus = retainedPromptStatus({ status, text });
        result.push({
            key: `${id}:${suffix}`, kind, label,
            original: effectiveStatus === "unavailable" || typeof text !== "string" ? null : text,
            status: effectiveStatus,
            ...(effectiveStatus !== status ? { sourceStatus: status, availabilityNote: `Retained text is empty; source marked ${status}. Not reconstructed.` } : {}),
        });
    };
    add("origin", "origin", "Original request", scenario.userPrompt?.text, scenario.userPrompt?.status ?? "unavailable");
    Object.assign(result.at(-1), promptAvailabilityFields(scenario.userPrompt));
    result.at(-1).authorship = promptAuthorship.read(scenario.userPrompt);
    result.at(-1).originKind = promptAuthorship.originKind(scenario);
    for (const [i, p] of (scenario.followUpPrompts ?? []).entries()) {
        add(`followup:${i}`, "followup", `Follow-up ${i + 1} (association inferred)`, p.text, p.status);
        Object.assign(result.at(-1), promptAvailabilityFields(p));
        if (p.reportAuthorExcluded) {
            delete result.at(-1).activityState;
            result.at(-1).label = `Follow-up ${i + 1} excluded by report author choice`;
            result.at(-1).availabilityNote = "Excluded by originating-group author choice; no original or report copy is disclosed.";
        }
        result.at(-1).authorship = promptAuthorship.read(p);
        result.at(-1).originKind = promptAuthorship.originKind(scenario, p);
    }
    for (const [i, call] of (scenario.toolCalls ?? []).entries()) {
        function visit(value, location = [], selected = false) {
            if (typeof value === "string" && selected) {
                add(`tool:${i}:${result.length}`, "tool", `Tool ${i + 1}: ${location.join(".")}`, value);
            } else if (Array.isArray(value)) value.forEach((v, index) => visit(v, [...location, String(index)], selected));
            else if (plainObject(value)) for (const [key, child] of Object.entries(value)) {
                const promptField = /^(?:question|query|filter|prompt|instructions)$/i.test(key);
                // Untrusted object keys are never included in exported labels.
                visit(child, [...location, promptField ? key.toLowerCase() : "field"], selected || promptField);
            }
        }
        visit(call.requestArgs);
    }
    return result;
}

export function projectReportCopy(entry, options) {
    const override = options.overrides.find((o) => o.key === entry.key);
    const omitted = options.promptMode === "none" || override?.omit === true;
    const edited = !omitted && override?.text !== undefined && override.text !== entry.original;
    const copy = omitted || entry.original === null ? { text: null, segments: [], changes: [] }
        : mask(override?.text ?? entry.original, options.promptMode, options.manualTerms);
    return {
        ...entry, omitted, edited, ...copy,
        representation: omitted ? "omitted" : entry.original === null ? "unavailable"
            : edited ? "edited-copy" : options.promptMode === "masked" ? "masked-copy" : copy.changes.length ? "original-with-mandatory-or-manual-removals" : "retained-original",
    };
}

export function projectPrompts(scenario, id, input = {}, keyAliases = new Map()) {
    const options = normalizeReportOptions(input);
    const review = sourcePrompts(scenario, id).map(entry => projectReportCopy({ ...entry, key: keyAliases.get(entry.key) ?? entry.key }, options));
    return {
        prompts: review.map(({ original, segments, edited, ...projected }) => projected),
        review,
        coverage: {
            total: review.length, included: review.filter((p) => p.text !== null).length,
            omitted: review.filter((p) => p.omitted).length, partial: review.filter((p) => p.status === "partial").length,
            unavailable: review.filter((p) => p.original === null && p.activityState !== "automatic").length,
            ...(review.some(p => p.activityState === "automatic") ? { noNewMessage: review.filter(p => p.activityState === "automatic").length } : {}),
            edited: review.filter((p) => p.edited).length,
            mandatoryRemovals: review.reduce((n, p) => n + p.changes.filter((c) => c.mandatory).length, 0),
            changes: review.reduce((n, p) => n + p.changes.length, 0),
        },
    };
}
