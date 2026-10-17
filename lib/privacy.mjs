import { createHmac, createHash } from "node:crypto";
import { BoardError } from "./store.mjs";
import { validateGraphActivity } from "./graph-history.mjs";
import { freezeEvaluationFacts, evaluationGeneratedHashes } from "./report-facts.mjs";
import { validateReportContext } from "./report-context-shape.mjs";
import { validatePeriodReport } from "./period-report.mjs";

import { TEXT_RULES as RULES, findTextFindings } from "./privacy-text.mjs";
export { CREDENTIAL_CATEGORIES } from "./privacy-text.mjs";
const REQUIRED_ARGS = {
    "workiq-ask": ["question"], "workiq-retrieve": ["query"], "workiq-search_paths": ["query|filter"],
    "workiq-get_schema": ["path"], "workiq-fetch": ["entityUrls"], "workiq-fetch_blob": ["path"],
    "workiq-call_function": ["functionUrl"], "workiq-do_action": ["actionUrl"], "workiq-create_entity": ["parentUrl"],
    "workiq-update_entity": ["entityUrl"], "workiq-delete_entity": ["entityUrl"], "workiq-list_agents": [],
    "owned-graph-http": ["method", "path"],
};
const LIMITATIONS = [
    "Local bounded pattern scan, not perfect DLP or a privacy certification.",
    "False positives and false negatives are possible; free-form business-sensitive narrative and unlabelled person names cannot be reliably recognized.",
    "Only retained source text can be reviewed. Missing or partial text is disclosed, never reconstructed.",
    "Prompt inclusion is for a local file only, not permission to publish or upload it. Detected credentials are always removed.",
    "Explicit disclosure-review attestation is required; the app does not independently verify the reviewer's identity or that a human read every line.",
];

export function retainedPromptStatus(prompt) {
    if (!prompt || !["full", "partial", "unavailable"].includes(prompt.status) || prompt.status === "full" && typeof prompt.text !== "string" || prompt.text != null && typeof prompt.text !== "string") {
        throw new BoardError("Selected prompt coverage is unsupported. Correct its source status before reviewing; nothing exported.", 422);
    }
    return typeof prompt.text === "string" && !prompt.text.trim() ? "unavailable" : prompt.status;
}

export function textFindings(text) {
    if (typeof text !== "string") throw new BoardError("Prompt text must be a string.", 422);
    return findTextFindings(text);
}

export function scanTree(value, allowed = new Set()) {
    const categories = Object.fromEntries(RULES.map(([name]) => [name, 0]));
    const stack = new Set();
    let fields = 0, strings = 0, characters = 0;
    function visit(item) {
        if (++fields > 100000) throw new BoardError("Privacy scan field limit exceeded. Narrow the selection; nothing exported.", 422);
        if (typeof item === "string") {
            strings++; characters += item.length;
            if (characters > 4 * 1024 * 1024) throw new BoardError("Privacy scan text limit exceeded. Narrow the selection; nothing exported.", 422);
            for (const [name, rule] of RULES) {
                rule.lastIndex = 0;
                for (const match of item.matchAll(rule)) {
                    if (allowed.has(match[0])) continue;
                    if (name === "opaque_identifiers" && !/[0-9+/=]/.test(match[0])) continue;
                    if (name === "private_urls" && /^https:\/\/graph\.microsoft\.com(?:\/(?:v1\.0|beta)\/\$metadata)?$/.test(match[0])) continue;
                    categories[name]++;
                }
            }
        } else if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
            // Known JSON scalars carry no unscanned text.
        } else if (typeof item === "object" && !stack.has(item) && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype)) {
            stack.add(item);
            for (const [key, child] of Object.entries(item)) { visit(key); visit(child); }
            stack.delete(item);
        } else {
            throw new BoardError("Unknown, circular or unscanned value encountered. Privacy review blocked; nothing exported.", 422);
        }
    }
    visit(value);
    return { categories, fieldsScanned: fields, stringsScanned: strings, charactersScanned: characters };
}

export function scanSourceForExport(scenarios, key) {
    if (!Array.isArray(scenarios) || !scenarios.length) throw new BoardError("Privacy review requires a non-empty exact selection.", 422);
    let originatingPrompts = 0, followUpPrompts = 0, toolArgumentObjects = 0, graphActivityRecords = 0, partialPrompts = 0, unavailablePrompts = 0;
    for (const scenario of scenarios) {
        if (!Array.isArray(scenario.followUpPrompts) || typeof scenario.title !== "string") throw new BoardError("Selected source field coverage is unknown. Privacy review blocked; nothing exported.", 422);
        const prompts = [scenario.userPrompt, ...(scenario.followUpPrompts ?? [])];
        for (const prompt of prompts) {
            const status = retainedPromptStatus(prompt);
            if (status === "partial") partialPrompts++;
            if (status === "unavailable" || !prompt.text) unavailablePrompts++;
        }
        originatingPrompts++;
        followUpPrompts += prompts.length - 1;
        if (!Array.isArray(scenario.toolCalls) || scenario.graphActivities !== undefined && !Array.isArray(scenario.graphActivities)) {
            throw new BoardError("Selected tool or Graph evidence schema is unsupported. Privacy review blocked.", 422);
        }
        if (!scenario.toolCalls.length && !scenario.graphActivities?.length) throw new BoardError("Selected tool evidence is missing. Privacy review blocked.", 422);
        for (const activity of scenario.graphActivities ?? []) {
            try { validateGraphActivity(activity); }
            catch (error) {
                if (!(error instanceof TypeError)) throw error;
                throw new BoardError("Selected Graph evidence schema is unsupported or incomplete. Privacy review blocked.", 422);
            }
            graphActivityRecords++;
        }
        for (const call of scenario.toolCalls) {
            const required = Object.hasOwn(REQUIRED_ARGS, call.tool) ? REQUIRED_ARGS[call.tool] : null;
            const args = call.requestArgs;
            if (!required || !args || typeof args !== "object" || Array.isArray(args)) throw new BoardError("Unknown tool schema or missing arguments. Privacy review blocked; nothing exported.", 422);
            for (const field of required) if (!field.split("|").some((name) => Object.hasOwn(args, name) && args[name] !== null && args[name] !== "" && (!Array.isArray(args[name]) || args[name].length > 0))) {
                throw new BoardError("A required tool prompt/argument field is missing. Privacy review blocked; nothing exported.", 422);
            }
            toolArgumentObjects++;
        }
    }
    const findings = scanTree(scenarios);
    return {
        scannerVersion: 2,
        inputFingerprint: createHmac("sha256", key).update(JSON.stringify(scenarios)).digest("hex"),
        selectedScenarioCount: scenarios.length, originatingPrompts, followUpPrompts, toolArgumentObjects, graphActivityRecords, partialPrompts, unavailablePrompts,
        ...findings, allSelectedFieldsScanned: true,
        transformation: "Prompt copies follow the selected mode; detected credentials are always removed. Source titles, notes, identifiers and non-prompt argument literals remain withheld or pseudonymized.",
        reviewerConfirmed: false, reviewerIdentityVerified: false, limitations: LIMITATIONS,
    };
}

export function scanReportMetadata(metadata, generated = new Set(), projectedRecords = []) {
    const factText = new Set();
    let characters = 0;
    function remember(text) {
        if (factText.has(text)) return;
        characters += text.length;
        if (factText.size >= 100000 || characters > 4 * 1024 * 1024) {
            throw new BoardError("Projected evaluation metadata scan limit exceeded. Narrow the selection; nothing exported.", 422);
        }
        factText.add(text);
    }
    function visit(value) {
        if (typeof value === "string") remember(value);
        else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
            remember(key);
            visit(child);
        }
    }
    function validatedFacts(facts) {
        try { visit(freezeEvaluationFacts(facts)); }
        catch (error) {
            if (error.name !== "ContractError") throw error;
            throw new BoardError(`Projected evaluation facts are invalid: ${error.code}. Nothing exported.`, 422);
        }
    }
    const view = { ...metadata };
    if (Object.hasOwn(view, "evaluationFacts") && view.evaluationFacts !== null) {
        validatedFacts(view.evaluationFacts);
        view.evaluationFacts = null;
    }
    if (Array.isArray(view.sourceFacts)) view.sourceFacts = view.sourceFacts.map(source => {
        if (!Object.hasOwn(source, "evaluationFacts") || source.evaluationFacts === null) return source;
        validatedFacts(source.evaluationFacts);
        return { ...source, evaluationFacts: null };
    });
    if (view.periodComparison !== undefined) {
        validatePeriodReport(view.periodComparison);
        visit(view.periodComparison);
        view.periodComparison = null;
    }
    // Closed-schema facts repeat basis/definition/reference strings extensively.
    // Validate every field, then scan every distinct key/string under the unchanged
    // global scanTree budgets; numeric leaves are already type-validated.
    return scanTree([projectedRecords, view, [...factText]], generated);
}

export function assertProjectedBundle(bundle, { pendingPdf = false } = {}) {
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    const hash = (v) => createHash("sha256").update(v).digest("hex");
    const kind = bundle.kind ?? bundle.snapshot.kind ?? "report";
    if (!["report", "comparison"].includes(kind) || (manifest.kind ?? "report") !== kind
        || (bundle.snapshot.kind ?? "report") !== kind) throw new BoardError("Report artifact kind changed after rendering.", 422);
    if (manifest.schemaVersion !== 3 || hash(JSON.stringify(bundle.snapshot)) !== manifest.snapshotHash || JSON.stringify(bundle.records) !== JSON.stringify(bundle.snapshot.records)) {
        throw new BoardError("Report snapshot integrity check failed. Prepare a new review.", 422);
    }
    if (bundle.title !== bundle.snapshot.title || manifest.title !== bundle.snapshot.title) {
        throw new BoardError("Report title changed after rendering. Prepare a new review.", 422);
    }
    const prefix = kind === "comparison" ? "comparison-report" : "product-report";
    const formatFiles = { html: `${prefix}.html`, pdf: `${prefix}.pdf`, json: `${prefix}.json`, markdown: `${prefix}.md` };
    for (const format of bundle.formats) if (!(pendingPdf && format === "pdf") && !Object.hasOwn(bundle.files, formatFiles[format])) throw new BoardError("A selected report format is missing. Nothing exported.", 422);
    if (JSON.stringify(bundle.formats) !== JSON.stringify(manifest.formats) || bundle.promptMode !== manifest.promptMode) throw new BoardError("Report choices changed after rendering. Prepare a new review.", 422);
    for (const key of ["timeContext", "preparedAtDisplay", "dateSelection", "dateRange"]) {
        if (JSON.stringify(manifest[key]) !== JSON.stringify(bundle.snapshot[key])) throw new BoardError("Report time context changed after rendering. Prepare a new review.", 422);
    }
    if (JSON.stringify(bundle.timeContext) !== JSON.stringify(bundle.snapshot.timeContext)) throw new BoardError("Report timezone changed after rendering. Prepare a new review.", 422);
    if (JSON.stringify(manifest.selectionScope) !== JSON.stringify(bundle.snapshot.selectionScope)) throw new BoardError("Report selection scope changed after rendering. Prepare a new review.", 422);
    if (JSON.stringify(manifest.presentation) !== JSON.stringify(bundle.snapshot.presentation)) throw new BoardError("Report presentation rules changed after review.", 422);
    const factHashes = [];
    if (bundle.snapshot.periodComparison !== undefined || manifest.periodComparison !== undefined || manifest.periodComparisonHash !== undefined) {
        validatePeriodReport(bundle.snapshot.periodComparison, bundle.records);
        if (kind !== "report" || bundle.snapshot.evaluationFacts !== undefined || manifest.evaluationFacts !== undefined
            || JSON.stringify(bundle.snapshot.periodComparison) !== JSON.stringify(manifest.periodComparison)
            || hash(JSON.stringify(manifest.periodComparison)) !== manifest.periodComparisonHash) {
            throw new BoardError("Frozen period comparison changed after rendering.", 422);
        }
        factHashes.push(manifest.periodComparisonHash);
        for (const side of Object.values(manifest.periodComparison.periods)) factHashes.push(...evaluationGeneratedHashes(side.facts),
            ...side.associations.map(item => item.reviewStatusRevision).filter(Boolean));
    }
    if (bundle.snapshot.recordedContext || manifest.recordedContext) {
        try { validateReportContext(bundle.snapshot.recordedContext, bundle.records, bundle.promptMode); }
        catch (error) { throw new BoardError(`Report context validation failed: ${error.message}`, 422); }
        if (JSON.stringify(bundle.snapshot.recordedContext) !== JSON.stringify(manifest.recordedContext)
            || hash(JSON.stringify(manifest.recordedContext)) !== manifest.recordedContextHash) throw new BoardError("Frozen report context changed after rendering.", 422);
        factHashes.push(manifest.recordedContextHash);
        for (const entry of bundle.snapshot.recordedContext.entries) {
            if (entry.text !== null && textFindings(entry.text).some(finding => finding.mandatory || bundle.promptMode === "masked" && finding.category !== "sensitivity_markings")) {
                throw new BoardError("A contextual report copy contains blocked personal or credential patterns. Edit, mask or omit it.", 422);
            }
        }
    }
    function checkFacts(facts) {
        try {
            freezeEvaluationFacts(facts);
            factHashes.push(...evaluationGeneratedHashes(facts));
        } catch (error) {
            if (error.name !== "ContractError") throw error;
            throw new BoardError(`Projected evaluation facts are invalid: ${error.code}. Nothing exported.`, 422);
        }
    }
    if (bundle.snapshot.evaluationFacts || manifest.evaluationFacts) {
        if (JSON.stringify(bundle.snapshot.evaluationFacts) !== JSON.stringify(manifest.evaluationFacts)
            || hash(JSON.stringify(manifest.evaluationFacts)) !== manifest.evaluationFactsHash) {
            throw new BoardError("Frozen evaluation facts changed after rendering.", 422);
        }
        checkFacts(manifest.evaluationFacts);
        factHashes.push(manifest.evaluationFactsHash);
    }
    if (kind === "comparison") {
        if (bundle.promptMode !== "none" || bundle.records.length !== 0
            || !Array.isArray(manifest.sourceReports) || manifest.sourceReports.length !== 2
            || new Set(manifest.sourceReports.map(source => source.bundleId)).size !== 2
            || !Array.isArray(manifest.sourceFacts) || manifest.sourceFacts.length !== 2) {
            throw new BoardError("Comparison exports require exactly two frozen sources and no prompt text.", 422);
        }
        for (const key of ["sourceReports", "sourceFacts", "comparison"]) {
            if (JSON.stringify(bundle.snapshot[key]) !== JSON.stringify(manifest[key])) throw new BoardError("Comparison facts changed after rendering.", 422);
        }
        if (hash(JSON.stringify(manifest.comparison)) !== manifest.comparisonHash
            || hash(JSON.stringify(manifest.sourceFacts)) !== manifest.sourceFactsHash) throw new BoardError("Comparison integrity check failed.", 422);
        for (const [index, source] of manifest.sourceReports.entries()) {
            if (!/^export-[a-f0-9-]{36}$/.test(source.bundleId) || !/^[a-f0-9]{64}$/.test(source.snapshotHash)
                || JSON.stringify(manifest.sourceFacts[index].report) !== JSON.stringify(source)) {
                throw new BoardError("Comparison source identity is invalid.", 422);
            }
            const compared = index ? manifest.comparison.later : manifest.comparison.baseline;
            if (compared?.bundleId !== source.bundleId || compared.snapshotHash !== source.snapshotHash) throw new BoardError("Comparison source binding changed.", 422);
            factHashes.push(source.snapshotHash, source.bundleId.replace(/^export-/, ""));
            if (manifest.sourceFacts[index].evaluationFacts) checkFacts(manifest.sourceFacts[index].evaluationFacts);
        }
        factHashes.push(manifest.comparisonHash, manifest.sourceFactsHash);
    }
    const generated = new Set([
        bundle.bundleId.replace(/^export-/, ""),
        bundle.privacy.inputFingerprint,
        manifest.snapshotHash,
        ...Object.values(manifest.files).map((f) => f.sha256),
        ...factHashes,
    ]);
    for (const [name, bytes] of Object.entries(bundle.files)) {
        if (name === "coverage-and-redaction-manifest.json") continue;
        if (!bundle.formats.some(format => formatFiles[format] === name) || manifest.files[name]?.sha256 !== hash(bytes)) {
            throw new BoardError("Report file integrity check failed. Nothing exported.", 422);
        }
        if (name === formatFiles.pdf && (!Buffer.isBuffer(bytes) || bytes.subarray(0, 5).toString() !== "%PDF-")) throw new BoardError("PDF renderer did not return a PDF. Nothing exported.", 422);
    }
    for (const record of bundle.records) {
        if (record.promptMode !== bundle.promptMode || !Array.isArray(record.prompts)) throw new BoardError("Prompt projection mode mismatch.", 422);
        for (const prompt of record.prompts) {
            if (bundle.promptMode === "none" && prompt.text !== null) throw new BoardError("No-prompts mode cannot contain prompt text.", 422);
            if (prompt.text === null) continue;
            const blocked = textFindings(prompt.text).filter((f) => f.mandatory || bundle.promptMode === "masked" && f.category !== "sensitivity_markings");
            if (blocked.length) throw new BoardError("A report copy still contains blocked personal or credential patterns. Edit, mask or omit that prompt; nothing exported.", 422);
        }
    }
    const metadata = manifest.recordedContext ? { ...manifest, recordedContext: { ...manifest.recordedContext,
        entries: manifest.recordedContext.entries.map(({ text, ...entry }) => entry) } } : manifest;
    const result = scanReportMetadata(metadata, generated,
        bundle.records.map(({ prompts, ...record }) => ({ ...record, prompts: prompts.map(({ text, ...prompt }) => prompt) })));
    const blocking = Object.entries(result.categories).filter(([name, count]) => count && name !== "sensitivity_markings");
    if (blocking.length) throw new BoardError(`Projected export contains blocked categories: ${blocking.map(([name]) => name).join(", ")}. Nothing exported.`, 422);
    return { allProjectedTextScanned: true, allFilesHashBound: true, blockedCategoryCount: 0, note: "Prompt copies and technical metadata were pattern-scanned. PDF is generated offline from the same escaped HTML; file hashes bind every format. This is not semantic privacy certification." };
}
