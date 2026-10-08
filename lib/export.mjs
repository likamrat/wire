import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { BoardError, resolveDataDir, loadBoardState, updateBoardState, mergeEvidenceWithState, writeExclusive } from "./store.mjs";
import { routeShape, GRAPH_ORIGIN } from "./graph.mjs";
import { scanSourceForExport, assertProjectedBundle } from "./privacy.mjs";
import { renderMarkdownReport, renderHtmlReport, reportServiceCategories, reportSummary } from "./product-report.mjs";
import { projectGraphActivity } from "./graph-history.mjs";
import { normalizeReportOptions, projectPrompts } from "./prompt-projection.mjs";
import { renderPdf } from "./pdf.mjs";
import { time } from "./time.mjs";
import { selectExportSnapshot, buildExportCatalog } from "./export-selection.mjs";
import { evaluationAdapter } from "./assessment-read-model.mjs";
import { projectCurrentEvaluationFacts } from "./report-facts.mjs";
import { inspectComparisonPair, buildComparisonBundle, normalizeComparisonOptions, openSavedComparison } from "./comparison-export.mjs";
import { assertSavedReportDependencies, assertArtifactWritable } from "./report-artifacts.mjs";
import { reportPresentation } from "./report-presentation.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";
import { serviceCategories } from "./service-categories.mjs";

const TOOLS = ["workiq-search_paths", "workiq-get_schema", "workiq-retrieve", "workiq-fetch", "workiq-ask", "workiq-list_agents", "workiq-fetch_blob", "workiq-call_function", "workiq-do_action", "workiq-create_entity", "workiq-update_entity", "workiq-delete_entity", "owned-graph-http"];
const PATHS = ["/me/messages", "/businessapps/me", "/me/calendarView"];
const FIELDS = ["id", "subject", "start", "attendees"];
const ERROR_CODES = ["BadRequest", "InvalidRequest", "InvalidAuthenticationToken", "AccessDenied", "ErrorAccessDenied", "Authorization_RequestDenied", "Request_ResourceNotFound", "ResourceNotFound", "TooManyRequests", "ServiceUnavailable", "InternalServerError"];
const LEVELS = ["intermediary-reported", "self-observed-this-session", "direct-http-observed", "no-http-response"];
const PROVENANCE = ["human-authored", "coordinator-message", "recorded-user-message-origin-unverified"];
const LIMITS = [
    "Bounded app-listed archive-checked local history import; incomplete/truncated logs remain disclosed. Legacy snapshot cards are separate.",
    "Only GitHub Copilot chat history is represented; no cross-host integration is demonstrated.",
    "Research probes are distinguished from recorded worker scenarios.",
    "Work IQ intermediary results are not Graph HTTP. Only explicit owned-recorder responses are direct Graph HTTP evidence; task correctness is unknown.",
    "Prompt text follows the selected mode; detected credentials are always removed. Other workplace narrative and entity response bodies are withheld.",
];

const enumValue = (value, allowed, fallback = "unknown") => allowed.includes(value) ? value : fallback;
const withheld = (value) => ({ type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, value: "[withheld literal]" });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function sanitizedPath(value) {
    if (typeof value !== "string") return null;
    const question = value.indexOf("?");
    const base = question < 0 ? value : value.slice(0, question);
    const result = { path: PATHS.includes(base) ? base : routeShape(base)?.path ?? "[withheld path]", query: [] };
    if (question < 0) return result;
    for (const [key, literal] of new URLSearchParams(value.slice(question + 1))) {
        if (key === "$select") {
            result.query.push({ key, fields: literal.split(",").map((f) => enumValue(f, FIELDS, "[withheld field]")) });
        } else if (key === "$orderby") {
            const match = /^(start\/dateTime) (asc|desc)$/.exec(literal);
            result.query.push({ key, structure: match ? { field: match[1], direction: match[2] } : withheld(literal) });
        } else {
            result.query.push({
                key: enumValue(key, ["startDateTime", "endDateTime", "$top", "$filter", "$search", "$skip", "$skiptoken", "$expand"], "[withheld key]"),
                ...withheld(literal),
            });
        }
    }
    return result;
}

function sanitizedArgs(tool, args = {}) {
    const result = {};
    if (tool === "workiq-search_paths" && Object.hasOwn(args, "query")) {
        result.query = PATHS.includes(args.query) ? sanitizedPath(args.query) : withheld(args.query);
    }
    if (tool === "workiq-get_schema") {
        result.path = sanitizedPath(args.path);
        result.operationType = enumValue(args.operationType, ["fetch", "create", "update", "delete", "action", "function"]);
        result.format = enumValue(args.format, ["jsonschema", "typescript"]);
    }
    if (tool === "workiq-retrieve") {
        result.query = Array.isArray(args.query) ? args.query.map(withheld) : withheld(args.query);
        result.strategy = enumValue(args.strategy, ["grounding", "search"]);
    }
    if (tool === "workiq-fetch") {
        result.entityUrls = Array.isArray(args.entityUrls) ? args.entityUrls.map(sanitizedPath) : withheld(args.entityUrls);
    }
    for (const name of ["functionUrl", "actionUrl", "entityUrl", "parentUrl"]) {
        if (Object.hasOwn(args, name) && TOOLS.includes(tool)) result[name] = sanitizedPath(args[name]);
    }
    if (tool === "workiq-fetch_blob") result.path = sanitizedPath(args.path);
    if (tool === "workiq-ask") result.question = withheld(args.question);
    if (tool === "workiq-search_paths" && Object.hasOwn(args, "filter")) result.filter = withheld(args.filter);
    if (tool === "owned-graph-http") { result.method = enumValue(args.method, ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]); result.path = sanitizedPath(args.path); }
    if (Object.hasOwn(args, "jsonBody")) result.jsonBody = withheld(args.jsonBody);
    const allowedKeys = {
        "workiq-search_paths": ["query"], "workiq-get_schema": ["path", "operationType", "format"],
        "workiq-retrieve": ["query", "strategy"], "workiq-fetch": ["entityUrls"],
    }[tool] ?? [];
    result.withheldAdditionalArgumentCount = Object.keys(args).filter((key) => !allowedKeys.includes(key) && !Object.hasOwn(result, key)).length;
    return result;
}

function sanitizedHttp(record, id) {
    const actual = record.synthetic === false && record.observedGraphHttp === true && record.responseOrigin === GRAPH_ORIGIN && record.classification === "direct-graph-http";
    return {
        recordId: id("http", record.recordId), classification: enumValue(record.classification, ["direct-graph-http", "imported-graph-http", "synthetic-http-fixture"]),
        synthetic: record.synthetic === true, observedGraphHttp: actual,
        method: enumValue(record.method, ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]),
        requestedMethod: enumValue(record.requestedMethod ?? record.method, ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]),
        redirected: record.redirected === true,
        origin: record.responseOrigin === GRAPH_ORIGIN ? GRAPH_ORIGIN : null,
        apiVersion: enumValue(record.apiVersion, ["v1.0", "beta"]),
        path: routeShape(record.responsePath?.path ?? record.requestedPath?.path),
        requestShape: {
            path: routeShape(record.requestedPath?.path),
            query: (record.requestedPath?.query ?? []).map((q) => ({
                key: enumValue(q.key, ["$select", "$filter", "$search", "$orderby", "$top", "$skip", "$skiptoken", "$expand", "$count", "startDateTime", "endDateTime"], "[withheld key]"),
                value: "[withheld literal]",
            })),
            bodyPresent: record.requestShape?.bodyPresent === true,
            authorizationPresent: record.requestShape?.authorizationPresent === true,
            cookiePresent: record.requestShape?.cookiePresent === true,
        },
        status: Number.isInteger(record.status) && record.status >= 100 && record.status <= 599 ? record.status : null,
        durationMs: Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : null,
        durationBoundary: "dispatch-to-response-headers",
        requestId: id("request", record.requestId),
        requestClientRequestId: id("client-request", record.requestClientRequestId),
        responseClientRequestId: id("client-request", record.responseClientRequestId),
        retryAfter: record.retryAfter?.seconds != null && Number.isFinite(record.retryAfter.seconds) ? { seconds: record.retryAfter.seconds } : record.retryAfter ? { valueWithheld: true } : null,
        paginationPresent: typeof record.paginationPresent === "boolean" ? record.paginationPresent : null,
        bodyMetadataInspection: record.bodyInspection?.startsWith("caller-provided parsed JSON") ? "observed-parsed-json" : record.bodyInspection === "metadata-inspection-failed" ? "inspection-failed" : "not-inspected",
        batchSubresponses: (record.batchSubresponses ?? []).map((r, index) => ({
            index, status: Number.isInteger(r.status) ? r.status : null,
            requestId: id("request", r.requestId), clientRequestId: id("client-request", r.clientRequestId),
            retryAfterSeconds: Number.isFinite(r.retryAfter?.seconds) ? r.retryAfter.seconds : null,
            paginationPresent: typeof r.paginationPresent === "boolean" ? r.paginationPresent : null,
        })),
        correlation: {
            sessionId: id("session", record.correlation?.sessionId), scenarioId: id("scenario", record.correlation?.scenarioId),
            toolCallId: id("call", record.correlation?.toolCallId),
            establishedBy: enumValue(record.correlation?.establishedBy, ["explicit-owned-caller"]),
        },
        transportError: enumValue(record.transportError, ["network-error", "AbortError", "TimeoutError"], null),
        bodiesAndSensitiveHeadersExcluded: true,
    };
}

export function buildSanitizedRecord(scenario, key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("A private pseudonym key is required.");
    const id = (kind, value) => value == null ? null : `${kind}-${createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;
    const httpRecords = (scenario.httpRecords ?? []).map((record) => sanitizedHttp(record, id));
    const graphActivities = (scenario.graphActivities ?? []).map((activity) => projectGraphActivity(activity, id));
    const tools = (scenario.toolCalls ?? []).map((tc) => {
        const tool = enumValue(tc.tool, TOOLS, "[withheld tool]");
        return {
            tool,
            toolCallId: id("call", tc.toolCallId),
            parentToolCallId: id("call", tc.parentToolCallId),
            startEventId: id("event", tc.startEventId),
            completionEventId: id("event", tc.completionEventId),
            order: Number.isSafeInteger(tc.order) && tc.order > 0 ? tc.order : null,
            parallelGroup: id("parallel", tc.parallelGroup),
            requestArgs: sanitizedArgs(tool, tc.requestArgs),
            requestedApiPath: sanitizedPath(tc.requestedApiPath),
            reportedOutcome: enumValue(tc.reportedOutcome, ["succeeded", "failed", "partial", "unknown"]),
            toolSucceeded: typeof tc.toolSucceeded === "boolean" ? tc.toolSucceeded : null,
            durationMs: Number.isFinite(tc.durationMs) && tc.durationMs >= 0 ? tc.durationMs : null,
            apiResults: (tc.apiResults ?? []).map((r) => ({
                index: Number.isSafeInteger(r.index) && r.index >= 0 ? r.index : null,
                indexKind: enumValue(r.indexKind, ["response-array-position"], "unspecified"),
                statusCode: Number.isInteger(r.statusCode) && r.statusCode >= 100 && r.statusCode <= 599 ? r.statusCode : null,
                errorCode: r.errorCode == null ? null : enumValue(r.errorCode, ERROR_CODES, "[withheld non-allowlisted error code]"),
                evidenceLevel: enumValue(r.evidenceLevel, LEVELS),
            })),
            observedGraphHttp: tool === "owned-graph-http" && httpRecords.some((r) => r.observedGraphHttp),
            graphEvidence: tool === "owned-graph-http" ? "Owned opt-in HTTP recorder; see separately classified records." : "Hosted Work IQ internal Graph HTTP is not observed.",
        };
    });
    const technicalSummary = [
        ...tools.map((tc) => `${tc.tool}${tc.requestedApiPath ? ` on ${tc.requestedApiPath.path}` : ""}`),
        ...graphActivities.map((activity) => `${activity.evidenceLevel} on ${activity.endpoint.label}`),
    ].join("; ");
    const prompt = (p) => ({
        originalStatus: enumValue(p?.status, ["full", "partial", "unavailable"]),
        provenance: enumValue(p?.provenance, PROVENANCE),
        sourceEventId: id("event", p?.sourceEventId),
        exportRepresentation: "technical-summary-not-original",
        text: `Original withheld. Operation structure: ${technicalSummary || "not available"}.`,
    });
    return {
        scenarioId: id("scenario", scenario.scenarioId),
        title: technicalSummary || "Recorded operation",
        family: enumValue(scenario.family, ["discovery", "retrieval", "reads_functions", "delegation", "mutations"]),
        sourceHost: enumValue(scenario.sourceHost, ["copilot-app", "copilot-app-chat"]),
        sourceSessionId: id("session", scenario.sourceSessionId),
        projectId: id("project", scenario.projectId),
        workloadKind: enumValue(scenario.workloadKind, ["grounding-research-probe", "agent-coordinator-experiment", "recorded-history", "public-metadata-demonstration"]),
        sample: scenario.sample === true,
        workflowStateAtPreview: enumValue(scenario.workflowState, ["captured", "reviewing", "ready_to_export", "exported"]),
        userPrompt: prompt(scenario.userPrompt),
        followUpPrompts: (scenario.followUpPrompts ?? []).map(prompt),
        promptAssociation: scenario.promptAssociation ? "Nearest-message association is inferred, not confirmed." : "Association from the manually assembled snapshot; not independently causal.",
        toolCalls: tools,
        evidenceLayer: enumValue(scenario.evidenceLayer, ["workiq-intermediary", "direct-graph-http", "imported-graph-http", "legacy-snapshot", "recorded-graph-history"]),
        isLegacy: scenario.isLegacy === true,
        httpRecords,
        graphActivities,
        sourceEligibility: scenario.sourceEligibility ? { archivedAt: null, basis: "app-inventory-and-read-only-archive-fields-at-import" } : null,
        ...(scenario.assessedFinding === "discovery-relevance-mismatch" ? {
            assessedFinding: { kind: "discovery-relevance-mismatch", provenance: "manual-assessment-not-tool-api-status" },
        } : {}),
        coverageNote: "Metadata-only evidence. Original narrative and response entity bodies withheld. No task correctness assessment.",
        taskCorrectness: "unknown",
    };
}

export async function buildSanitizedBundle(scenarios, key, input = {}, pdfRenderer = renderPdf, selectionScope, evaluationFacts) {
    const options = normalizeReportOptions(input);
    const privacy = scanSourceForExport(scenarios, key);
    privacy.promptMode = options.promptMode;
    const promptReview = [];
    const promptCoverage = { total: 0, included: 0, omitted: 0, partial: 0, unavailable: 0, edited: 0, mandatoryRemovals: 0, changes: 0 };
    const records = scenarios.map((s) => {
        const record = buildSanitizedRecord(s, key);
        const projection = projectPrompts(s, record.scenarioId, options);
        promptReview.push(...projection.review);
        for (const name of Object.keys(promptCoverage)) promptCoverage[name] += projection.coverage[name];
        delete record.userPrompt;
        delete record.followUpPrompts;
        return {
            ...record, projectionVersion: 3, promptMode: options.promptMode, prompts: projection.prompts,
            coverageNote: "Report copies follow the selected prompt mode. Other private narrative and response entity bodies are withheld. Task correctness is unknown.",
        };
    });
    if (options.overrides.some((edit) => !promptReview.some((p) => p.key === edit.key))) throw new BoardError("A prompt edit no longer belongs to the selection. Clear edits and prepare a new preview.", 409);
    const bundleId = `export-${randomUUID()}`;
    const preparedAt = evaluationFacts?.preparedAt ?? new Date().toISOString();
    const range = time.range(options.dateSelection, options.timeContext.timeZone);
    const facts = projectCurrentEvaluationFacts(evaluationFacts ?? evaluationAdapter.buildReportFacts(scenarios, { revision: 0, pseudonymKey: key }, {
        preparedAt, scope: { kind: selectionScope?.kind ?? "selected", from: range.from ?? null, untilExclusive: range.to ?? null, timeZone: options.timeContext.timeZone },
    }).facts);
    const snapshot = {
        schemaVersion: 3, kind: "report", bundleId, preparedAt, promptMode: options.promptMode, formats: options.formats,
        timeContext: options.timeContext, preparedAtDisplay: time.formatTime(preparedAt, options.timeContext),
        dateSelection: options.dateSelection, dateRange: time.range(options.dateSelection, options.timeContext.timeZone),
        ...(selectionScope ? { selectionScope: structuredClone(selectionScope) } : {}),
        summary: reportSummary(records, { timeContext: options.timeContext }),
        promptCoverage, serviceCategories: reportServiceCategories(records, { timeContext: options.timeContext }), limits: LIMITS,
        categoryDefinition: serviceCategories.definition,
        coverage: {
            scenarioCount: records.length, sampleCount: records.filter((s) => s.sample).length,
            distinctSourceSessions: new Set(records.map((s) => s.sourceSessionId)).size,
            distinctProjects: new Set(records.filter((s) => s.projectId).map((s) => s.projectId)).size,
            unscopedSessions: new Set(records.filter((s) => !s.projectId).map((s) => s.sourceSessionId)).size,
            families: [...new Set(records.map((s) => s.family))],
            historicalEligibleSourceSessions: new Set(records.filter((s) => s.sourceEligibility && !s.isLegacy).map((s) => s.sourceSessionId)).size,
            directGraphHttpRecords: records.flatMap((s) => s.httpRecords).filter((r) => r.observedGraphHttp && !r.synthetic).length,
            legacyRecords: records.filter((s) => s.isLegacy).length,
            recordedGraphRequestSites: records.flatMap((s) => s.graphActivities).filter((r) => !r.synthetic && r.evidenceLevel !== "code-reference").length,
            graphOutputVisibleStatuses: records.flatMap((s) => s.graphActivities).filter((r) => !r.synthetic && r.evidenceLevel === "output-visible-http").length,
            graphCodeReferences: records.flatMap((s) => s.graphActivities).filter((r) => !r.synthetic && r.evidenceLevel === "code-reference").length,
        },
        records,
        evaluationFacts: facts, presentation: reportPresentation,
    };
    const previewHtml = renderHtmlReport(records, { snapshot, privacy });
    const files = {};
    if (options.formats.includes("html")) files["product-report.html"] = previewHtml;
    if (options.formats.includes("json")) files["product-report.json"] = JSON.stringify(snapshot, null, 2) + "\n";
    if (options.formats.includes("markdown")) files["product-report.md"] = renderMarkdownReport(records, { snapshot, privacy });
    const manifest = {
        schemaVersion: 3, kind: "report", bundleId, preparedAt, promptMode: options.promptMode, formats: options.formats,
        timeContext: snapshot.timeContext, preparedAtDisplay: snapshot.preparedAtDisplay,
        dateSelection: snapshot.dateSelection, dateRange: snapshot.dateRange,
        ...(snapshot.selectionScope ? { selectionScope: snapshot.selectionScope } : {}),
        snapshotHash: sha256(JSON.stringify(snapshot)), snapshot: snapshot.coverage, promptCoverage,
        categoryDefinition: snapshot.categoryDefinition,
        evaluationFacts: facts, evaluationFactsHash: sha256(JSON.stringify(facts)), presentation: reportPresentation,
        limits: LIMITS,
        privacyReview: privacy,
        transformations: {
            rawPromptTextExcluded: options.promptMode === "none",
            rawNarrativeTitlesNotesCoverageExcluded: true,
            nonPromptSourceUrlsPathsTimestampsAndEntityBodiesExcluded: true,
            promptRepresentation: "Retained source text projected separately as omitted, masked, original or edited copy. Missing/partial source status preserved, never reconstructed.",
            mandatoryCredentialRemoval: true,
            manualTermCount: options.manualTerms.length,
            overrideCount: options.overrides.length,
            perPrompt: records.flatMap((r) => r.prompts.map(({ key, kind, status, representation, changes }) => ({ key, kind, status, representation, changes }))),
            argumentStructure: "Question/query/filter/prompt/instructions text follows prompt mode in separate prompt sections. Other argument literals stay withheld; allowlisted operation structure is retained.",
            identifiers: "Keyed pseudonyms stable within this continued board. Private key and reverse mapping not exported.",
            results: "Retain valid numeric HTTP status metadata, null or allowlisted symbolic error codes, and allowlisted evidence levels. Missing metadata is null; unknown error literals are withheld.",
            outcomes: "Recorded tool outcomes separate from API subresults and assessed findings. Graph HTTP asserted only for explicitly classified real owned-recorder responses; task correctness unknown.",
            localHistory: "Unavailable or limited saved GitHub Copilot chat history can leave activity out of this report. Previously collected evidence is kept. History gaps are not failed Work IQ or Graph requests; source names, paths and raw diagnostics are not included here.",
            review: "Workflow state is the source classification at preview. Export never changes it. Original review history omitted.",
            scope: selectionScope ? "Complete eligible evidence for the chosen request groups, deduplicated using known identities. All means the available collected evidence, not every chat or hidden call. Synthetic, diagnostic and unknown-source evidence is excluded; counts and exclusions are frozen in selectionScope." : "Counts describe only the explicitly selected ready records, not the complete collection.",
        },
        files: {},
    };
    const bundle = {
        kind: "report", bundleId, preparedAt, records, snapshot, promptReview, previewHtml,
        timeContext: snapshot.timeContext,
        promptMode: options.promptMode, formats: options.formats, privacy, files,
    };
    const updateManifest = () => {
        manifest.files = Object.fromEntries(Object.entries(files).filter(([name]) => name !== "coverage-and-redaction-manifest.json").map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) }]));
        files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    };
    updateManifest();
    // Validate all projected text before it reaches the local PDF process.
    assertProjectedBundle(bundle, { pendingPdf: true });
    if (options.formats.includes("pdf")) files["product-report.pdf"] = await pdfRenderer(previewHtml);
    updateManifest();
    bundle.projectionScan = assertProjectedBundle(bundle);
    return bundle;
}

export async function writeBundle(session, bundle, currentState) {
    if (bundle.privacy?.reviewerConfirmed !== true) throw new BoardError("Explicit disclosure review must precede report writing.", 428);
    assertArtifactWritable(currentState, bundle.bundleId, bundle.kind ?? "report");
    assertProjectedBundle(bundle);
    const root = path.join(resolveDataDir(session), "exports");
    await mkdir(root, { recursive: true });
    const stagingDir = path.join(root, `.pending-${bundle.bundleId}`);
    const reservationDir = path.join(root, bundle.bundleId);
    const bundleDir = path.join(reservationDir, "files");
    // Exclusive staging allocation makes repeated writes fail, never overwrite.
    await mkdir(stagingDir);
    try {
        // Reserve the final directory too: rename must never replace an old bundle.
        await mkdir(reservationDir);
        for (const [name, content] of Object.entries(bundle.files)) await writeExclusive(path.join(stagingDir, name), content);
        await rename(stagingDir, bundleDir);
    } catch {
        throw new BoardError("Bundle write failed. Source and review labels are unchanged; an incomplete .pending directory may remain locally. Prepare a new preview.", 500);
    }
    return {
        bundleId: bundle.bundleId, kind: bundle.kind ?? "report", preparedAt: bundle.preparedAt, exportedAt: new Date().toISOString(), bundleDir,
        privacyReview: { reviewerConfirmed: true, reviewerIdentityVerified: false, confirmedAt: bundle.privacy.confirmedAt },
        promptMode: bundle.promptMode, formats: bundle.formats,
        timeContext: bundle.snapshot.timeContext, preparedAtDisplay: bundle.snapshot.preparedAtDisplay,
        ...(bundle.snapshot.selectionScope ? { selectionScope: bundle.snapshot.selectionScope } : {}),
        snapshotHash: sha256(JSON.stringify(bundle.snapshot)),
        manifestHash: sha256(bundle.files["coverage-and-redaction-manifest.json"]),
        ...(bundle.snapshot.evaluationFacts ? { evaluationFactsHash: sha256(JSON.stringify(bundle.snapshot.evaluationFacts)) } : {}),
        ...(bundle.kind === "comparison" ? { sourceReports: structuredClone(bundle.snapshot.sourceReports), comparisonHash: sha256(JSON.stringify(bundle.comparison)) } : {}),
        files: Object.fromEntries(Object.keys(bundle.files).map((name) => [name, path.join(bundleDir, name)])),
    };
}

function publicBundle(bundle) {
    return structuredClone({
        ...bundle,
        files: Object.fromEntries(Object.entries(bundle.files).map(([name, bytes]) => [name, Buffer.isBuffer(bytes) ? { encoding: "base64", mediaType: "application/pdf", data: bytes.toString("base64") } : bytes])),
    });
}

export function createExportController(session, writer = writeBundle, pdfRenderer = renderPdf, { evaluation = evaluationAdapter } = {}) {
    const previews = new Map();
    const generations = new Map();
    function discard(owner) {
        generations.delete(owner);
        for (const [id, p] of previews) if (p.owner === owner) previews.delete(id);
    }
    function checkTime(preview, context) {
        const invalidate = () => { for (const [id, value] of previews) if (value === preview) previews.delete(id); };
        let current;
        try { current = time.normalize(context); }
        catch { invalidate(); throw new BoardError("Invalid report timezone or locale. Prepare a new preview.", 422); }
        if ((preview.contextRequired || context !== undefined) && JSON.stringify(current) !== JSON.stringify(preview.bundle.timeContext)) {
            invalidate();
            throw new BoardError("Report timezone or locale changed. Prepare a new preview and disclosure review.", 409);
        }
    }
    function selectedRecords(state, preview) {
        const scenarios = mergeEvidenceWithState(state);
        const selected = preview.selection ? buildExportCatalog(scenarios).records.filter(s => preview.scenarioIds.includes(s.scenarioId))
            : scenarios.filter((s) => preview.scenarioIds.includes(s.scenarioId));
        if (selected.length !== preview.scenarioIds.length) throw new BoardError("Selected evidence changed or was deleted. Prepare a new report preview.", 409);
        return selected;
    }
    function invalidationKey(state) {
        return JSON.stringify([state.personalEvaluation?.consent?.revision ?? 0, activityDeletionVersion(state)]);
    }
    function assertEvaluation(preview, current) {
        if (!preview.evaluationDependencies) return;
        // Every caller has already matched the exact selected-source privacy fingerprint.
        try { evaluation.assertReportCurrent(preview.evaluationDependencies, current, { sourceContentVerified: true }); }
        catch (error) {
            if (error.name !== "ContractError") throw error;
            throw new BoardError("Assessment evidence changed. Prepare a fresh report preview.", 409);
        }
    }
    async function assertComparison(preview, current) {
        if (preview.invalidationKey !== invalidationKey(current)) throw new BoardError("Comparison approval became stale after a data or permission change.", 409);
        assertSavedReportDependencies(preview.sourceDependencies, current);
        const pair = await inspectComparisonPair(session, current, preview.sourceDependencies[0].bundleId, preview.sourceDependencies[1].bundleId, preview.comparisonOptions);
        if (JSON.stringify(pair.dependencies) !== JSON.stringify(preview.sourceDependencies)) throw new BoardError("A saved source report changed. Prepare a new comparison.", 409);
    }
    function comparisonPreview(owner, previewId) {
        const preview = previews.get(previewId);
        if (!preview || preview.owner !== owner || preview.kind !== "comparison") throw new BoardError("Comparison preview is no longer available.", 409);
        return preview;
    }
    const api = {
        async preview(owner, selection, input = {}, collectionSelection) {
            discard(owner);
            collectionSelection = collectionSelection === undefined ? undefined : structuredClone(collectionSelection);
            const generation = Symbol();
            generations.set(owner, generation);
            try {
            const state = await loadBoardState(session);
            const scenarios = mergeEvidenceWithState(state);
            if (collectionSelection !== undefined && selection !== undefined) throw new BoardError("Choose one report selection method.", 422);
            const ready = scenarios.filter((s) => s.workflowState === "ready_to_export");
            if (collectionSelection === undefined && selection !== undefined && (!Array.isArray(selection) || !selection.length || selection.length > 500 || new Set(selection).size !== selection.length || selection.some((id) => !ready.some((s) => s.scenarioId === id)))) {
                throw new BoardError("Selection must contain unique ready scenario IDs.");
            }
            const snapshotSelection = collectionSelection === undefined ? null : selectExportSnapshot(scenarios, collectionSelection, state.revision);
            const chosen = snapshotSelection?.records ?? (selection ? ready.filter((s) => selection.includes(s.scenarioId)) : ready);
            if (!chosen.length) throw new BoardError("No cards are ready to export.");
            for (const [id, p] of previews) if (Date.now() > p.expires || p.owner === owner) previews.delete(id);
            if (previews.size >= 32) throw new BoardError("Too many pending previews. Close or confirm an existing preview.", 409);
            const previewId = randomUUID();
            const options = normalizeReportOptions(input), preparedAt = new Date().toISOString();
            const range = time.range(options.dateSelection, options.timeContext.timeZone);
            const assessed = evaluation.buildReportFacts(chosen, state, { preparedAt, scope: {
                kind: snapshotSelection?.scope.kind ?? "selected", from: range.from ?? null, untilExclusive: range.to ?? null, timeZone: options.timeContext.timeZone,
            } });
            const bundle = await buildSanitizedBundle(chosen, state.pseudonymKey, input, pdfRenderer, snapshotSelection?.scope, assessed.facts);
            if (generations.get(owner) !== generation) throw new BoardError("Preview was cancelled or replaced. No files were written.", 409);
            const current = await loadBoardState(session);
            const selected = selectedRecords(current, { selection: collectionSelection, scenarioIds: chosen.map(s => s.scenarioId) });
            if (scanSourceForExport(selected, current.pseudonymKey).inputFingerprint !== bundle.privacy.inputFingerprint) throw new BoardError("Selected evidence changed while rendering. Prepare a new preview.", 409);
            assertEvaluation({ evaluationDependencies: assessed.dependencies }, current);
            previews.set(previewId, {
                kind: "report", owner, revision: state.revision, scenarioIds: chosen.map((s) => s.scenarioId),
                selection: collectionSelection,
                evaluationDependencies: assessed.dependencies,
                contextRequired: input.timeContext !== undefined,
                expires: Date.now() + 10 * 60_000, bundle,
            });
            return { previewId, revision: state.revision, expiresInSeconds: 600, ...publicBundle(bundle) };
            } finally {
                if (generations.get(owner) === generation) generations.delete(owner);
            }
        },
        async review(owner, previewId, disclosureReviewed, timeContext) {
            if (disclosureReviewed !== true) throw new BoardError("Explicit disclosure-review attestation is required.", 428);
            const preview = previews.get(previewId);
            if (!preview || preview.owner !== owner) throw new BoardError("Preview not found for this panel. Prepare a new privacy scan.", 409);
            checkTime(preview, timeContext);
            const current = await loadBoardState(session);
            if (Date.now() > preview.expires) throw new BoardError("Preview expired. Prepare a new privacy scan and disclosure review.", 409);
            if (preview.kind === "comparison") await assertComparison(preview, current);
            else {
                const selected = selectedRecords(current, preview);
                if (!preview.selection && selected.some((s) => s.workflowState !== "ready_to_export")) throw new BoardError("Selection or content changed. Prepare a new privacy scan and disclosure review.", 409);
                const rescanned = scanSourceForExport(selected, current.pseudonymKey);
                if (rescanned.inputFingerprint !== preview.bundle.privacy.inputFingerprint) throw new BoardError("Selected content changed. Privacy rescan and review are required.", 409);
                assertEvaluation(preview, current);
            }
            if (previews.get(previewId) !== preview) throw new BoardError("Preview was cancelled or replaced. Prepare a new review.", 409);
            preview.bundle.privacy = { ...preview.bundle.privacy, reviewerConfirmed: true, reviewChannel: "explicit-disclosure-attestation", confirmedAt: new Date().toISOString() };
            const manifest = JSON.parse(preview.bundle.files["coverage-and-redaction-manifest.json"]);
            manifest.privacyReview = preview.bundle.privacy;
            preview.bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
            preview.bundle.projectionScan = assertProjectedBundle(preview.bundle);
            preview.reviewed = true;
            return { previewId, revision: preview.revision, ...publicBundle(preview.bundle) };
        },
        async confirm(owner, previewId, confirmed, timeContext) {
            if (confirmed !== true || typeof previewId !== "string") throw new BoardError("Explicit local export confirmation is required.");
            const preview = previews.get(previewId);
            if (!preview || preview.owner !== owner) throw new BoardError("Preview not found for this panel. Prepare a new preview.", 409);
            checkTime(preview, timeContext);
            if (!preview.reviewed) throw new BoardError("Complete explicit disclosure review in the preview before confirming export.", 428);
            previews.delete(previewId);
            let written;
            try {
                const { state } = await updateBoardState(session, async (current) => {
                    if (Date.now() > preview.expires || preview.kind !== "comparison" && !preview.selection && preview.scenarioIds.some((id) => current.cards[id]?.workflowState !== "ready_to_export")) {
                        throw new BoardError("Board changed or preview expired. Nothing exported; prepare a new preview.", 409);
                    }
                    if (preview.kind === "comparison") await assertComparison(preview, current);
                    else {
                        const selected = selectedRecords(current, preview);
                        if (scanSourceForExport(selected, current.pseudonymKey).inputFingerprint !== preview.bundle.privacy.inputFingerprint) throw new BoardError("Selected content changed; a fresh privacy review is required.", 409);
                        assertEvaluation(preview, current);
                    }
                    assertArtifactWritable(current, preview.bundle.bundleId, preview.bundle.kind ?? "report");
                    written = await writer(session, preview.bundle, current);
                    if (preview.kind !== "comparison") written.scenarioIds = preview.scenarioIds;
                    current.exports.push(written);
                    current.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
                    current.artifactDeletion.revision += 1;
                });
                return { bundle: written, state };
            } catch (error) {
                if (written) throw new BoardError(`Bundle files were written to ${written.bundleDir}, but export-history commit failed. Source and review labels are unchanged. Reload state before continuing.`, 500);
                throw error;
            }
        },
        async inspectComparison(owner, baselineId, laterId, input = {}) {
            const state = await loadBoardState(session);
            const pair = await inspectComparisonPair(session, state, baselineId, laterId, input);
            const current = await loadBoardState(session);
            assertSavedReportDependencies(pair.dependencies, current);
            return { comparison: pair.comparison, sources: pair.sources };
        },
        async previewComparison(owner, baselineId, laterId, input = {}) {
            discard(owner);
            const settings = normalizeComparisonOptions(input);
            const options = { formats: settings.formats, timeContext: settings.timeContext, cohort: settings.cohort };
            const generation = { sourceIds: [baselineId, laterId] };
            generations.set(owner, generation);
            try {
                const state = await loadBoardState(session);
                for (const [id, pending] of previews) if (Date.now() > pending.expires) previews.delete(id);
                if (previews.size >= 32) throw new BoardError("Too many pending previews. Close an existing preview.", 409);
                const pair = await inspectComparisonPair(session, state, baselineId, laterId, options);
                const bundle = await buildComparisonBundle(pair, options, pdfRenderer);
                const previewId = randomUUID(), preview = {
                    kind: "comparison", owner, revision: state.revision, sourceDependencies: pair.dependencies,
                    comparisonOptions: options, invalidationKey: invalidationKey(state),
                    contextRequired: input.timeContext !== undefined, expires: Date.now() + 10 * 60_000, bundle,
                };
                if (generations.get(owner) !== generation) throw new BoardError("Comparison preview was cancelled or replaced.", 409);
                await assertComparison(preview, await loadBoardState(session));
                if (generations.get(owner) !== generation) throw new BoardError("Comparison preview was cancelled or replaced.", 409);
                previews.set(previewId, preview);
                return { previewId, revision: state.revision, expiresInSeconds: 600, ...publicBundle(bundle) };
            } finally {
                if (generations.get(owner) === generation) generations.delete(owner);
            }
        },
        async reviewComparison(owner, previewId, confirmed, context) {
            comparisonPreview(owner, previewId);
            return api.review(owner, previewId, confirmed, context);
        },
        async confirmComparison(owner, previewId, confirmed, context) {
            comparisonPreview(owner, previewId);
            return api.confirm(owner, previewId, confirmed, context);
        },
        async openComparison(owner, bundleId) {
            return openSavedComparison(session, await loadBoardState(session), bundleId);
        },
        invalidateSavedReport(bundleId) {
            for (const [id, preview] of previews) if (preview.sourceDependencies?.some(source => source.bundleId === bundleId)) previews.delete(id);
            for (const [owner, generation] of generations) if (generation?.sourceIds?.includes(bundleId)) generations.delete(owner);
        },
        invalidateDerived() { previews.clear(); generations.clear(); },
        cancel(owner, previewId) {
            if (previews.get(previewId)?.owner === owner) previews.delete(previewId);
        },
        discardAll() { previews.clear(); generations.clear(); },
        discard,
    };
    return api;
}
