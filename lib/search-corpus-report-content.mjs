import { corpusHash, corpusText, reportDocumentText, comparisonDocumentText } from "./search-corpus-content.mjs";
import { pdfDocumentText } from "./search-corpus-pdf.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { freezeEvaluationFacts } from "./report-facts.mjs";
import { validateReportContext } from "./report-context-shape.mjs";
import { textFindings } from "./privacy.mjs";

export class ReportContentError extends Error {
    constructor(code) { super(`Saved report content is unavailable (${code}).`); this.code = code; }
}

function utf8(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ReportContentError("report-invalid-utf8"); }
}

const blockedCopy = (text, mode) => textFindings(text).some(finding =>
    finding.mandatory || mode === "masked" && finding.category !== "sensitivity_markings");

function recordedContext(snapshot, manifest) {
    const inSnapshot = Object.hasOwn(snapshot, "recordedContext"), inManifest = Object.hasOwn(manifest, "recordedContext");
    if (!inSnapshot && !inManifest && !Object.hasOwn(manifest, "recordedContextHash")) return null;
    if (!inSnapshot || !inManifest || snapshot.promptMode === "none"
        || JSON.stringify(snapshot.recordedContext) !== JSON.stringify(manifest.recordedContext)
        || corpusHash(manifest.recordedContext) !== manifest.recordedContextHash) throw new ReportContentError("report-context-integrity");
    let context;
    try { context = validateReportContext(snapshot.recordedContext, snapshot.records, snapshot.promptMode); }
    catch { throw new ReportContentError("report-context-invalid"); }
    if (context.entries.some(entry => entry.text !== null && blockedCopy(entry.text, snapshot.promptMode))) {
        throw new ReportContentError("report-context-private-pattern");
    }
    return context;
}

function jsonText(snapshot, manifest) {
    const context = recordedContext(snapshot, manifest);
    if (snapshot.summary != null && (typeof snapshot.summary !== "object" || Array.isArray(snapshot.summary))) throw new ReportContentError("report-invalid-field");
    const list = value => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) throw new ReportContentError("report-invalid-field");
        return value;
    };
    const parts = [], add = (...values) => {
        for (const value of values) {
            if (value === null || value === undefined) continue;
            if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) throw new ReportContentError("report-invalid-field");
            parts.push(String(value));
        }
    };
    add(...list(snapshot.summary?.takeaways), ...list(snapshot.summary?.services));
    for (const metric of list(snapshot.summary?.metrics)) {
        add(metric.label, metric.layer, metric.unit, metric.count, metric.reading);
    }
    if (snapshot.evaluationFacts != null) {
        let facts;
        try { facts = freezeEvaluationFacts(snapshot.evaluationFacts); }
        catch { throw new ReportContentError("report-invalid-facts"); }
        add(comparisonDocumentText(facts));
        for (const assessment of facts.assessments) {
            add(assessment.dimension, assessment.checkId, assessment.origin, assessment.verdict, assessment.reason);
        }
    }
    for (const record of snapshot.records) {
        add(record.title, record.evidenceLayer, record.coverageNote, record.promptAssociation);
        for (const prompt of record.prompts) {
            if (!["full", "partial", "unavailable"].includes(prompt.status) || !["origin", "followup", "tool"].includes(prompt.kind)
                || prompt.omitted !== undefined && typeof prompt.omitted !== "boolean"
                || prompt.text !== null && typeof prompt.text !== "string") throw new ReportContentError("report-invalid-prompt");
            const omitted = snapshot.promptMode === "none" || prompt.omitted === true || prompt.status === "unavailable";
            if (omitted && prompt.text !== null) throw new ReportContentError("report-invalid-prompt");
            if (prompt.text !== null && blockedCopy(prompt.text, snapshot.promptMode)) throw new ReportContentError("report-invalid-prompt");
            const author = promptAuthorship.read(prompt);
            add(prompt.label, prompt.status, prompt.representation, author.actor, author.basis);
            if (!omitted) add(prompt.text);
        }
        for (const call of list(record.toolCalls)) {
            add(call.tool, call.reportedOutcome, call.requestedApiPath?.method, call.requestedApiPath?.path);
            for (const result of list(call.apiResults)) add(result.statusCode, result.errorCode, result.evidenceLevel);
        }
        for (const activity of list(record.graphActivities)) {
            add(activity.tool, activity.evidenceLevel, activity.endpoint?.label, activity.endpoint?.path, activity.httpStatus);
        }
        for (const httpRecord of list(record.httpRecords)) add(httpRecord.method, httpRecord.status, httpRecord.responsePath?.path);
    }
    const coverage = {};
    if (context) {
        add(context.boundary, context.limitation);
        const entries = new Map(context.entries.map(entry => [entry.key, entry])), seen = new Set();
        for (const anchor of context.anchors) {
            add(...anchor.gaps);
            for (const key of anchor.entryKeys) if (!seen.has(key)) {
                seen.add(key);
                const entry = entries.get(key);
                add(entry.label, entry.status, entry.representation, entry.finality, entry.authorship?.actor, entry.availabilityNote, entry.text);
            }
        }
        Object.assign(coverage, { contextEntries: context.coverage.entries, contextIncluded: context.coverage.included,
            contextPartial: context.coverage.partial, contextUnavailable: context.coverage.unavailable, contextOmitted: context.coverage.omitted });
    }
    return { content: corpusText(parts.join("\n")), coverage };
}

export async function extractReportFile(document, { signal } = {}) {
    signal?.throwIfAborted();
    let content, coverage = { format: document.format };
    if (document.format === "html") content = reportDocumentText(utf8(document.bytes));
    else if (document.format === "json") {
        const extracted = jsonText(document.snapshot, document.manifest);
        content = extracted.content;
        Object.assign(coverage, extracted.coverage);
    }
    else if (document.format === "markdown") {
        content = corpusText(utf8(document.bytes));
        coverage.representation = "markdown-source";
    } else if (document.format === "pdf") {
        const extracted = await pdfDocumentText(document.bytes, { signal });
        content = corpusText(extracted.content);
        coverage = { ...coverage, representation: "pdf-text-layer", pages: extracted.pages, pagesWithText: extracted.pagesWithText };
    } else throw new ReportContentError("report-unsupported-format");
    signal?.throwIfAborted();
    if (!content.trim()) throw new ReportContentError("empty-artifact-content");
    return { content, coverage };
}
