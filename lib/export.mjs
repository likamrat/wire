import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { hostPaths } from "./host-paths.mjs";
import { BoardError, resolveDataDir, loadBoardState, updateBoardState, mergeEvidenceWithState, writeExclusive, readPrivateEvidenceBytes } from "./store.mjs";
import { collectorFor } from "./collector.mjs";
import { routeShape, GRAPH_ORIGIN } from "./graph.mjs";
import { scanSourceForExport, assertProjectedBundle } from "./privacy.mjs";
import { renderMarkdownReport, renderHtmlReport, reportServiceCategories, reportSummary } from "./product-report.mjs";
import { projectGraphActivity } from "./graph-history.mjs";
import { normalizeReportOptions, projectPrompts, projectReportTitle } from "./prompt-projection.mjs";
import { reportIdentity } from "./report-identity.mjs";
import { renderPdf } from "./pdf.mjs";
import { time } from "./time.mjs";
import { selectExportSnapshot, buildExportCatalog, validateExportSelection, summarizeExportSelection } from "./export-selection.mjs";
import { projectPromptOrigins } from "./activity-analytics.mjs";
import { selectReportPopulation, freezeReportPopulation, validateReportPopulation, resolveReportView } from "./report-population.mjs";
import { projectReportNotes } from "./report-notes.mjs";
import { projectReportPatterns } from "./report-patterns.mjs";
import { reportLocalSaveRequest, hasReportSaveAuthorization, reportSaveAuthorizationSummary,
    assertReportSaveAuthorization, confirmReportLocalSave } from "./report-save-consent.mjs";
import { evaluationAdapter, buildAssessmentModel } from "./assessment-read-model.mjs";
import { METRIC_PROJECTION_VERSION } from "./assessment-contract.mjs";
import { projectCurrentEvaluationFacts } from "./report-facts.mjs";
import { inspectComparisonPair, buildComparisonBundle, normalizeComparisonOptions, openSavedComparison } from "./comparison-export.mjs";
import { assertSavedReportDependencies, assertArtifactWritable, SAVED_REPORT_MAX_BYTES } from "./report-artifacts.mjs";
import { currentReportPresentation as reportPresentation, hasCurrentReportPresentation } from "./report-presentation.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { collectReportContext, projectReportContext, reportDisclosureRecords, reportContextSource, reportContextRef } from "./report-context.mjs";
import { acceptPeriodReport, freezePeriodReport, validatePeriodReport, periodReportInput, periodAssessmentSignature, assertPeriodApiParents } from "./period-report.mjs";
import { renderPeriodReportHtml, renderPeriodReportMarkdown } from "./period-report-output.mjs";
import { projectReportResults } from "./report-result-projection.mjs";
import { projectReportResultText } from "./report-result-text.mjs";
import { periodResultTextFacts } from "./report-result-facts.mjs";
import { projectNativeReportEvidence } from "./native-report-evidence.mjs";
import { isNativeReportSource, assertNativeReportRuntime } from "./native-persistence.mjs";
import { nativeReportSelectionExpectations, assertNativeReportSelection } from "./native-report-selection.mjs";
import { assembleNativeReportSelection, readNativePeriodView } from "./native-report-stream.mjs";
import { restrictSavedArtifactMetadata } from "./runtime-artifact-metadata.mjs";
import { nativeRetentionHash } from "./native-retention-contract.mjs";
import { REPORT_CONTEXT_LIMITS } from "./report-context-shape.mjs";

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
        coverageNote: "Metadata-only evidence. Original narrative and response entity bodies withheld. No task correctness assessment.",
        taskCorrectness: "unknown",
    };
}

function assertBundleReadableSize(bundle) {
    if (Object.values(bundle.files).some(bytes => Buffer.byteLength(bytes) > SAVED_REPORT_MAX_BYTES)) {
        throw new BoardError("This report exceeds the supported saved-file size. Narrow the selection, omit text or choose another format; no files were saved.", 422);
    }
}

export async function buildSanitizedBundle(scenarios, key, input = {}, pdfRenderer = renderPdf, selectionScope, evaluationFacts, recordedContext, periodComparison, nativeFrame, reportPopulation) {
    const options = normalizeReportOptions(input);
    scenarios = projectPromptOrigins(scenarios);
    if (options.reportFocus && (!reportPopulation || periodComparison || nativeFrame)
        || reportPopulation && JSON.stringify(reportPopulation.focus) !== JSON.stringify(options.reportFocus)) {
        throw new BoardError("Report presets require their captured interaction population.", 422);
    }
    if (nativeFrame && options.reportNotes?.length) {
        throw new BoardError("Notes on examples require qualified originating interactions. This source currently provides retained conversations instead.", 422);
    }
    const nativeOptions = { ...options, overrides: options.overrides.filter(edit => edit.key.startsWith("native-copy-")) };
    const legacyOptions = { ...options, overrides: options.overrides.filter(edit =>
        !edit.key.startsWith("result-copy-") && (!nativeFrame || !edit.key.startsWith("native-copy-"))) };
    if (periodComparison) {
        if (periodComparison.definitions?.metricProjectionVersion !== METRIC_PROJECTION_VERSION
            || periodComparison.periods?.baseline?.facts?.metricProjectionVersion !== METRIC_PROJECTION_VERSION
            || periodComparison.periods?.later?.facts?.metricProjectionVersion !== METRIC_PROJECTION_VERSION) {
            throw new BoardError("New period reports require the current metric projection on both sides. Open historical saved files without regenerating them.", 422);
        }
        validatePeriodReport(periodComparison);
    }
    if (periodComparison && options.dateSelection.range !== "capture") throw new BoardError("Paired report dates are fixed to the accepted comparison, not an ordinary report date range.", 422);
    recordedContext = options.recordedContext ? recordedContext : null;
    if (options.recordedContext && !recordedContext && (scenarios.length || !nativeFrame)) throw new BoardError("Recorded context must be resolved from the current authorized report selection.", 422);
    const privacy = scanSourceForExport(scenarios, key, { nativeRecords: nativeFrame?.records ?? [] });
    privacy.promptMode = options.promptMode;
    if (options.saveMode === "local") {
        privacy.limitations = privacy.limitations?.filter(line => !line.startsWith("Explicit disclosure-review attestation"));
    }
    const reviewedCopies = new Map();
    const contextMessages = new Map((recordedContext?.entries ?? []).filter(entry => entry.eventRef).map(entry => [entry.eventRef, entry.key]));
    const promptCoverage = { total: 0, included: 0, omitted: 0, partial: 0, unavailable: 0, edited: 0, mandatoryRemovals: 0, changes: 0 };
    const records = scenarios.map((s) => {
        const record = buildSanitizedRecord(s, key);
        const aliases = new Map();
        if (recordedContext) for (const [suffix, prompt] of [
            ["origin", s.userPrompt], ...(s.followUpPrompts ?? []).map((prompt, index) => [`followup:${index}`, prompt]),
        ]) {
            if (typeof s.sourceSessionId !== "string" || !s.sourceSessionId || typeof prompt?.sourceEventId !== "string" || !prompt.sourceEventId) continue;
            const eventRef = reportContextRef(key, "event", JSON.stringify([s.sourceSessionId, prompt.sourceEventId]));
            if (contextMessages.has(eventRef)) aliases.set(`${record.scenarioId}:${suffix}`, contextMessages.get(eventRef));
        }
        const projection = projectPrompts(s, record.scenarioId, legacyOptions, aliases);
        for (const copy of projection.review) {
            const previous = reviewedCopies.get(copy.key);
            if (previous && (previous.original !== copy.original || previous.status !== copy.status)) {
                throw new BoardError("Linked copies of a recorded message conflict. Narrow the report rather than substituting text.", 422);
            }
            if (!previous || copy.kind === "origin") reviewedCopies.set(copy.key, copy);
        }
        for (const name of Object.keys(promptCoverage).filter(name => name !== "noNewMessage")) promptCoverage[name] += projection.coverage[name];
        if (projection.coverage.noNewMessage) promptCoverage.noNewMessage = (promptCoverage.noNewMessage ?? 0) + projection.coverage.noNewMessage;
        delete record.userPrompt;
        delete record.followUpPrompts;
        return {
            ...record, projectionVersion: 3, promptMode: options.promptMode, prompts: projection.prompts,
            ...(periodComparison ? { title: "Supporting comparison copies", toolCalls: [], graphActivities: [], httpRecords: [] } : {}),
            coverageNote: "Report copies follow the selected prompt mode. Other private narrative and response entity bodies are withheld. Task correctness is unknown.",
        };
    });
    const promptReview = [...reviewedCopies.values()];
    const context = projectReportContext(recordedContext, legacyOptions, promptReview);
    if (context) privacy.context = { allContextFieldsScanned: true, ...context.scan, coverage: context.frozen.coverage };
    if (legacyOptions.overrides.some((edit) => ![...promptReview, ...(context?.review ?? [])].some((p) => p.key === edit.key))) throw new BoardError("A prompt edit no longer belongs to the selection. Clear edits and prepare a new preview.", 409);
    const bundleId = `export-${randomUUID()}`;
    const preparedAt = evaluationFacts?.preparedAt ?? periodComparison?.periods.baseline.facts.preparedAt ?? new Date().toISOString();
    const range = time.range(options.dateSelection, options.timeContext.timeZone);
    const facts = periodComparison && !nativeFrame || nativeFrame && !scenarios.length ? null : projectCurrentEvaluationFacts(evaluationFacts ?? evaluationAdapter.buildReportFacts(scenarios, { revision: 0, pseudonymKey: key }, {
        preparedAt, scope: { kind: selectionScope?.kind ?? "selected", from: range.from ?? null, untilExclusive: range.to ?? null, timeZone: options.timeContext.timeZone },
    }).facts);
    const native = nativeFrame ? projectNativeReportEvidence(nativeFrame, key, nativeOptions,
        { githubRecords: records, ...(facts ? { githubEvaluationFacts: facts } : {}),
            ...(periodComparison?.nativePeriods?.refinement ? { contextOnlyScenarioIds: nativeFrame.records.filter(record =>
                periodComparison.nativePeriods.refinement.contextConversationRefs.includes(reportContextRef(key, "scenario", record.scenarioId)))
                .map(record => record.scenarioId) } : {}) }) : null;
    const resultBinding = periodComparison ? periodResultTextFacts(periodComparison) : null;
    if (options.resultText && periodComparison && periodComparison.definitions.resultProjectionVersion !== 1) {
        throw new BoardError("This older period definition has no result-text membership. Create a current comparison before selecting result text.", 422);
    }
    const resultProjection = projectReportResults(scenarios, key,
        { githubFacts: facts, nativeFrame, nativeEvidence: native?.nativeEvidence,
            ...(resultBinding ? { memberRefs: resultBinding.calls.map(call => call.ref) } : {}) });
    const resultText = resultProjection ? projectReportResultText(resultProjection, key, options) : null;
    if (options.overrides.some(edit => edit.key.startsWith("result-copy-") && !resultText?.review.some(copy => copy.key === edit.key))) {
        throw new BoardError("A result-text edit no longer belongs to this selected report. Clear those edits and prepare again.", 409);
    }
    const presetTitle = options.reportFocus && ({ all: "All activity", errors: "Errors & failures",
        completed: "Completed calls", mine: "My prompts", agent: "Agent prompts", custom: "Activity report" })[options.reportFocus.preset];
    const title = projectReportTitle(options.title || presetTitle || reportIdentity.defaultTitle({ kind: "report", selectionScope, periodComparison }), options);
    const projectedRecords = native?.records ?? records;
    const notes = projectReportNotes(options, projectedRecords);
    if (notes) {
        const copies = new Map([...promptReview, ...(context?.review ?? []), ...(native?.review ?? [])].map(copy => [copy.key, copy.original ?? ""]));
        for (const note of options.reportNotes) copies.set(`note:${note.scenarioId}`, note.text);
        if (copies.size > REPORT_CONTEXT_LIMITS.entries
            || [...copies.values()].reduce((total, text) => total + Buffer.byteLength(text), 0) > REPORT_CONTEXT_LIMITS.bytes) {
            throw new BoardError("Report text and notes exceed the 3,000-copy or 4 MiB limit. Narrow the report or shorten its notes.", 422);
        }
    }
    if (notes) privacy.reportNotes = notes.scan;
    if (reportPopulation) validateReportPopulation(reportPopulation, projectedRecords);
    const patterns = reportPopulation ? projectReportPatterns(scenarios, facts, resultProjection.facts, key) : null;
    const snapshot = {
        schemaVersion: 3, kind: "report", bundleId, title: title.text, preparedAt, promptMode: options.promptMode, formats: options.formats,
        ...(options.saveMode === "local" ? { savePolicy: "local-save-v1" } : {}),
        timeContext: options.timeContext, preparedAtDisplay: time.formatTime(preparedAt, options.timeContext),
        ...(periodComparison ? {} : { dateSelection: options.dateSelection, dateRange: time.range(options.dateSelection, options.timeContext.timeZone) }),
        ...(selectionScope ? { selectionScope: structuredClone(selectionScope) } : {}),
        summary: periodComparison ? { takeaways: [periodComparison.scope.population], metrics: [], services: [] } : reportSummary(records, {
            timeContext: options.timeContext, presentation: reportPresentation, resultFacts: resultProjection?.facts }),
        promptCoverage, serviceCategories: periodComparison ? [] : reportServiceCategories(records, { timeContext: options.timeContext, presentation: reportPresentation }), limits: LIMITS,
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
        records: projectedRecords,
        ...(reportPopulation ? { reportPopulation: structuredClone(reportPopulation) } : {}),
        ...(notes ? { reportNotes: notes.frozen } : {}),
        ...(patterns ? { reportPatterns: patterns } : {}),
        ...(!periodComparison ? { resultFacts: resultProjection.facts } : {}),
        ...(resultText ? { resultText: resultText.frozen } : {}),
        ...(context ? { recordedContext: context.frozen } : {}),
        ...(native ? { nativeEvidence: native.nativeEvidence } : periodComparison ? {} : { evaluationFacts: facts }),
        ...(periodComparison ? { periodComparison } : {}), presentation: reportPresentation,
    };
    if (native && !records.length) {
        delete snapshot.coverage;
        snapshot.summary = { takeaways: ["Selected retained Microsoft evidence; complete source history is not established."], metrics: [], services: [] };
        snapshot.serviceCategories = [];
    }
    if (native) snapshot.limits = [
        "Selected committed Microsoft observations only; no complete source history is claimed.",
        "Native calls, returned-result observations, messages, parts and task states are separate units; none are pooled with GitHub activity.",
        "Input and result bodies remain withheld. Included text follows the selected privacy choices.",
        ...(records.length ? LIMITS.filter(line => !line.startsWith("Only GitHub")) : []),
    ];
    privacy.reportTitle = { ...title.scan, changes: title.changes };
    const previewHtml = periodComparison ? renderPeriodReportHtml(snapshot) : renderHtmlReport(snapshot.records, { snapshot, privacy });
    const files = {};
    if (options.formats.includes("html")) files["product-report.html"] = previewHtml;
    if (options.formats.includes("json")) files["product-report.json"] = JSON.stringify(snapshot, null, 2) + "\n";
    if (options.formats.includes("markdown")) files["product-report.md"] = periodComparison ? renderPeriodReportMarkdown(snapshot) : renderMarkdownReport(snapshot.records, { snapshot, privacy });
    const manifest = {
        schemaVersion: 3, kind: "report", bundleId, title: snapshot.title, preparedAt, promptMode: options.promptMode, formats: options.formats,
        ...(snapshot.savePolicy ? { savePolicy: snapshot.savePolicy } : {}),
        timeContext: snapshot.timeContext, preparedAtDisplay: snapshot.preparedAtDisplay,
        dateSelection: snapshot.dateSelection, dateRange: snapshot.dateRange,
        ...(snapshot.selectionScope ? { selectionScope: snapshot.selectionScope } : {}),
        snapshotHash: sha256(JSON.stringify(snapshot)), ...(snapshot.coverage ? { snapshot: snapshot.coverage } : {}), promptCoverage,
        ...(reportPopulation ? { reportPopulation: snapshot.reportPopulation, reportPopulationHash: sha256(JSON.stringify(snapshot.reportPopulation)) } : {}),
        ...(notes ? { reportNotes: notes.frozen, reportNotesHash: sha256(JSON.stringify(notes.frozen)) } : {}),
        ...(patterns ? { reportPatterns: patterns, reportPatternsHash: sha256(JSON.stringify(patterns)) } : {}),
        ...(context ? { recordedContext: context.frozen, recordedContextHash: sha256(JSON.stringify(context.frozen)) } : {}),
        categoryDefinition: snapshot.categoryDefinition,
        ...(!periodComparison ? { resultFacts: resultProjection.facts, resultFactsHash: sha256(JSON.stringify(resultProjection.facts)) } : {}),
        ...(resultText ? { resultText: resultText.frozen, resultTextHash: sha256(JSON.stringify(resultText.frozen)) } : {}),
        ...(native ? { nativeEvidence: native.nativeEvidence, nativeEvidenceHash: native.nativeEvidenceHash }
            : periodComparison ? {} : { evaluationFacts: facts, evaluationFactsHash: sha256(JSON.stringify(facts)) }),
        ...(periodComparison ? { periodComparison, periodComparisonHash: sha256(JSON.stringify(periodComparison)) } : {}), presentation: reportPresentation,
        limits: snapshot.limits,
        privacyReview: privacy,
        transformations: {
            rawPromptTextExcluded: options.promptMode === "none",
            rawNarrativeTitlesNotesCoverageExcluded: true,
            ...(notes ? { reportAuthorNotes: "Separately authored notes, linked to included interactions. Source history and recorded outcomes are unchanged." } : {}),
            nonPromptSourceUrlsPathsTimestampsAndEntityBodiesExcluded: !periodComparison?.nativePeriods && !resultText,
            ...(periodComparison?.nativePeriods ? { qualifiedNativeActivityDatesIncluded: true,
                nativeSourceUrlsPathsAndEntityBodiesExcluded: true } : {}),
            promptRepresentation: "Retained source text projected separately as omitted, masked, original or edited copy. Missing/partial source status preserved, never reconstructed.",
            mandatoryCredentialRemoval: true,
            resultTextMode: resultText ? "masked" : "none",
            resultTextRepresentation: "Only explicitly selected retained error and source-description fields are copied, always masked. Response entity bodies remain excluded.",
            manualTermCount: options.manualTerms.length,
            overrideCount: options.overrides.length,
            perPrompt: records.flatMap((r) => r.prompts.map(({ key, kind, status, representation, changes }) => ({ key, kind, status, representation, changes }))),
            argumentStructure: "Question/query/filter/prompt/instructions text follows prompt mode in separate prompt sections. Other argument literals stay withheld; allowlisted operation structure is retained.",
            identifiers: "Keyed pseudonyms stable within this continued board. Private key and reverse mapping not exported.",
            results: "Retain valid numeric HTTP status metadata, null or allowlisted symbolic error codes, and allowlisted evidence levels. Missing metadata is null; unknown error literals are withheld.",
            outcomes: "Recorded tool outcomes separate from API subresults and assessed findings. Graph HTTP asserted only for explicitly classified real owned-recorder responses; task correctness unknown.",
            localHistory: "Unavailable or limited saved GitHub Copilot chat history can leave activity out of this report. Previously collected evidence is kept. History gaps are not failed Work IQ or Graph requests; source names, paths and raw diagnostics are not included here.",
            review: "Workflow state is the source classification at preview. Export never changes it. Original review history omitted.",
            scope: periodComparison ? periodComparison.scope.population : selectionScope ? "Complete eligible evidence for the chosen request groups, deduplicated using known identities. All means the available collected evidence, not every chat or hidden call. Synthetic, diagnostic and unknown-source evidence is excluded; counts and exclusions are frozen in selectionScope." : "Counts describe only the explicitly selected ready records, not the complete collection.",
        },
        files: {},
    };
    const bundle = {
        kind: "report", bundleId, title: snapshot.title, preparedAt, records: snapshot.records, snapshot, promptReview, previewHtml,
        ...(native ? { nativeReview: native.review } : {}),
        ...(context ? { contextReview: context.review } : {}),
        ...(resultText ? { resultReview: resultText.review } : {}),
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
    assertBundleReadableSize(bundle);
    if (options.formats.includes("pdf")) files["product-report.pdf"] = await pdfRenderer(previewHtml);
    updateManifest();
    bundle.projectionScan = assertProjectedBundle(bundle);
    assertBundleReadableSize(bundle);
    if (options.saveMode === "local") bundle.localSaveRequest = reportLocalSaveRequest(manifest);
    return bundle;
}

export async function writeBundle(session, bundle, currentState, { assertCurrent = () => {} } = {}) {
    if (!hasReportSaveAuthorization(bundle.privacy)) throw new BoardError("Confirm saving this report before writing its files.", 428);
    if (bundle.privacy.localSave || bundle.snapshot.savePolicy !== undefined) {
        assertReportSaveAuthorization(JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]));
    }
    assertArtifactWritable(currentState, bundle.bundleId, bundle.kind ?? "report");
    assertProjectedBundle(bundle);
    assertBundleReadableSize(bundle);
    const root = path.join(resolveDataDir(session), "exports");
    const stagingDir = path.join(root, `.pending-${bundle.bundleId}`);
    const reservationDir = path.join(root, bundle.bundleId);
    const bundleDir = path.join(reservationDir, "files");
    assertCurrent();
    const registeredDirectory = hostPaths.stored(bundleDir);
    const registeredFiles = Object.fromEntries(Object.keys(bundle.files).map(name => [name, hostPaths.stored(path.join(bundleDir, name))]));
    assertCurrent();
    await mkdir(root, { recursive: true });
    assertCurrent();
    // Exclusive staging allocation makes repeated writes fail, never overwrite.
    await mkdir(stagingDir);
    try {
        assertCurrent();
        // Reserve the final directory too: rename must never replace an old bundle.
        await mkdir(reservationDir);
        assertCurrent();
        for (const [name, content] of Object.entries(bundle.files)) {
            await writeExclusive(path.join(stagingDir, name), content);
            assertCurrent();
        }
        await rename(stagingDir, bundleDir);
        assertCurrent();
    } catch (error) {
        const failure = new BoardError("Saving the report could not be confirmed. Some files may have been written. Check save status instead of saving again.", 500);
        failure.cause = error;
        throw failure;
    }
    return {
        bundleId: bundle.bundleId, kind: bundle.kind ?? "report", ...(bundle.title !== undefined ? { title: bundle.title } : {}), preparedAt: bundle.preparedAt, exportedAt: new Date().toISOString(), bundleDir: registeredDirectory,
        privacyReview: reportSaveAuthorizationSummary(bundle.privacy),
        promptMode: bundle.promptMode, formats: bundle.formats,
        ...(bundle.snapshot.savePolicy ? { savePolicy: bundle.snapshot.savePolicy } : {}),
        ...(bundle.snapshot.reportPopulation ? { reportPurpose: bundle.snapshot.reportPopulation.focus.preset } : {}),
        ...(bundle.kind !== "comparison" && bundle.snapshot.dateSelection ? { reportPeriod: structuredClone(bundle.snapshot.dateSelection) } : {}),
        timeContext: bundle.snapshot.timeContext, preparedAtDisplay: bundle.snapshot.preparedAtDisplay,
        ...(bundle.snapshot.selectionScope ? { selectionScope: bundle.snapshot.selectionScope } : {}),
        snapshotHash: sha256(JSON.stringify(bundle.snapshot)),
        manifestHash: sha256(bundle.files["coverage-and-redaction-manifest.json"]),
        ...(bundle.snapshot.evaluationFacts ? { evaluationFactsHash: sha256(JSON.stringify(bundle.snapshot.evaluationFacts)) } : {}),
        ...(bundle.snapshot.nativeEvidence ? { nativeEvidenceHash: sha256(JSON.stringify(bundle.snapshot.nativeEvidence)) } : {}),
        ...(bundle.snapshot.periodComparison ? { reportType: "period-comparison", periodComparisonHash: sha256(JSON.stringify(bundle.snapshot.periodComparison)) } : {}),
        ...(bundle.kind === "comparison" ? { sourceReports: structuredClone(bundle.snapshot.sourceReports), comparisonHash: sha256(JSON.stringify(bundle.comparison)) } : {}),
        ...(bundle.comparison?.nativeComparison ? { nativeComparisonHash: sha256(JSON.stringify(bundle.comparison)) } : {}),
        files: registeredFiles,
    };
}

function publicBundle(bundle) {
    return structuredClone({
        ...bundle,
        files: Object.fromEntries(Object.entries(bundle.files).map(([name, bytes]) => [name, Buffer.isBuffer(bytes) ? { encoding: "base64", mediaType: "application/pdf", data: bytes.toString("base64") } : bytes])),
    });
}

const reviewedNativeControllers = new WeakMap();
export function isReviewedNativeReportController(controller, session) {
    const original = reviewedNativeControllers.get(controller);
    return Boolean(original && original.session === session
        && ["preview", "review", "confirm"].every(method => controller[method] === original[method]));
}

const nativeSaveRefusals = new WeakMap();
export function takeNativeSaveRefusal(error, controller, session, owner, previewId) {
    const proof = nativeSaveRefusals.get(error);
    if (!proof || proof.controller !== controller || proof.session !== session || proof.owner !== owner
        || proof.disposition.previewId !== previewId) return null;
    nativeSaveRefusals.delete(error);
    return { ...proof.disposition };
}

export function createExportController(session, writer = writeBundle, pdfRenderer = renderPdf, { evaluation = evaluationAdapter } = {}) {
    const previews = new Map();
    const generations = new Map();
    const reviewedGenerations = new Map();
    function nativeServices(services, owner, preview) {
        const source = services.nativeReportSource, admission = services.nativeReportAdmission;
        if (!isNativeReportSource(source, session) || !admission || admission.owner !== owner
            || preview && preview.nativeSource !== source) {
            throw new BoardError("Native report preparation requires the current committed-source runtime and panel authority.", 503);
        }
        return { source, admission };
    }
    async function assembleNativeFrame(frame, source, admission, expected, owner, generation) {
        if (typeof source.iterateSelection !== "function") throw new BoardError("Native report preparation requires the bounded committed-selection runtime.", 503);
        return source.iterateSelection(frame, admission, async (events, assertCurrent, actual) => {
            const assembled = await assembleNativeReportSelection(events, {
                selection: frame.selection, expectations: frame.originalViewExpectations,
                definitions: frame.source.definitions, key: actual.pseudonymKey,
            });
            assertCurrent();
            if (expected) assertNativeReportSelection(expected, assembled.records, frame.source.definitions, actual.pseudonymKey);
            if (generations.get(owner) !== generation) throw new BoardError("Preview was cancelled or replaced. No files were written.", 409);
            return Object.freeze({ records: assembled.records, source: frame.source });
        });
    }
    function validateNativeView(view, selection, state) {
        const fields = ["kind", "revision", "sourceRevision", "definitions", "frame"];
        if (!view || Object.getPrototypeOf(view) !== Object.prototype || Object.keys(view).length !== fields.length
            || !fields.every(field => Object.hasOwn(view, field)) || view.kind !== selection.kind
            || view.revision !== state.revision || view.revision !== selection.revision
            || typeof view.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(view.sourceRevision)) {
            throw new BoardError("The original native report view no longer matches this scope. Read a current view before preparing.", 409);
        }
        nativeReportSelectionExpectations([], view.definitions, state.pseudonymKey);
        if (view.frame === null && selection.kind !== "selected") {
            throw new BoardError("The original Microsoft report scope has no authoritative source dependency. Nothing was prepared.", 503);
        }
        if (view.frame !== null && (!view.frame?.source || view.frame.source.sourceRevisionRef !== view.sourceRevision
            || nativeRetentionHash(view.frame.source.definitions) !== nativeRetentionHash(view.definitions))) {
            throw new BoardError("The native selection differs from its original source revision or definitions. Prepare from a current view.", 409);
        }
    }
    function rescan(state, selected, selection, nativeProjection) {
        return scanSourceForExport(disclosureRecords(state, selected, selection), state.pseudonymKey,
            { nativeRecords: nativeProjection?.records ?? [] });
    }
    async function publishNative(preview, services, publish) {
        if (!preview.nativeFrame) return publish();
        const { source, admission } = nativeServices(services, preview.owner, preview);
        const evidence = await readCapturedEvidence(preview);
        return source.validate(preview.nativeFrame, admission, current => {
            if (preview.scenarioIds.length) {
                if (!current) throw new BoardError("Mixed report publication requires locked source validation support.", 503);
                const captured = capturedReportState(current, preview, evidence);
                const selected = selectedRecords(captured, preview);
                assertSelected(preview, captured, selected);
                if (rescan(captured, selected, preview.selection, preview.nativeProjection).inputFingerprint !== preview.bundle.privacy.inputFingerprint) {
                    throw new BoardError("Selected mixed-report content changed before publication. Prepare a new review.", 409);
                }
                assertEvaluation(preview, captured);
            }
            return publish();
        });
    }
    function discard(owner) {
        generations.delete(owner);
        reviewedGenerations.delete(owner);
        for (const [id, p] of previews) if (p.owner === owner) previews.delete(id);
    }
    function checkTime(preview, context) {
        const invalidate = () => { for (const [id, value] of previews) if (value === preview) previews.delete(id); };
        if (!hasCurrentReportPresentation(preview.bundle.snapshot)) {
            invalidate();
            throw new BoardError("Report presentation changed. Prepare a new preview and disclosure review.", 409);
        }
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
    function evidenceAuthority(state) {
        return JSON.stringify([reportContextSource(session, state), invalidationKey(state), sha256(state.pseudonymKey)]);
    }
    function assertEvidenceAuthority(state, frame) {
        if (evidenceAuthority(state) !== frame.authority
            || state.deletion?.pending && state.deletion.operations?.[state.deletion.pending]?.kind !== "artifact-deletion") {
            throw new BoardError("The report's source permission or deletion authority changed. Prepare a fresh review.", 409);
        }
    }
    async function captureEvidenceFrame(state, chosen) {
        if (!chosen.length || !state.evidenceFile || !state.importCoverage?.dynamic
            || collectorFor(session)?.assessmentSource(state).available !== true) return null;
        const authority = evidenceAuthority(state);
        const info = await stat(path.join(resolveDataDir(session), "private-evidence", state.evidenceFile));
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1) {
            throw new BoardError("The collected report source could not be pinned.", 409);
        }
        return Object.freeze({ file: state.evidenceFile, maxBytes: info.size, authority });
    }
    async function readCapturedEvidence(preview) {
        if (!preview.evidenceFrame) return null;
        return JSON.parse(await readPrivateEvidenceBytes(session, preview.evidenceFrame.file,
            { maxBytes: preview.evidenceFrame.maxBytes }));
    }
    function capturedReportState(current, preview, evidence) {
        if (!preview.evidenceFrame) return current;
        assertEvidenceAuthority(current, preview.evidenceFrame);
        if (!Array.isArray(evidence?.records) || evidence.records.some(record => !current.cards[record.scenarioId])) {
            throw new BoardError("The prepared report source is missing or no longer authorized.", 409);
        }
        // Keep live review/permission state; never write the pinned evidence back to the store.
        return { ...current, evidenceFile: preview.evidenceFrame.file, evidence: evidence.records, importCoverage: current.importCoverage };
    }
    async function readReportState(current, preview) {
        if (preview.evidenceFrame) assertEvidenceAuthority(current, preview.evidenceFrame);
        return capturedReportState(current, preview, await readCapturedEvidence(preview));
    }
    function disclosureRecords(state, selected, selection) {
        return reportDisclosureRecords(mergeEvidenceWithState(state), selected, selection?.promptAuthors);
    }
    function selectedFingerprint(state, selected) {
        return createHmac("sha256", state.pseudonymKey).update(JSON.stringify(selected)).digest("hex");
    }
    function assertSelected(preview, state, selected) {
        if (preview.selectedFingerprint !== selectedFingerprint(state, selected)) throw new BoardError("Selected evidence changed. Prepare a new report preview.", 409);
    }
    function assertPopulation(preview, state) {
        if (!preview.population) return;
        const reference = selectExportSnapshot(mergeEvidenceWithState(state), {
            kind: "selected", revision: state.revision, scenarioIds: preview.population.scenarioIds,
            ...(preview.selection?.promptAuthors ? { promptAuthors: preview.selection.promptAuthors } : {}),
        }, state.revision);
        const current = freezeReportPopulation(selectReportPopulation(reference.records, preview.options), state.pseudonymKey);
        if (JSON.stringify([current.reference, current.included])
            !== JSON.stringify([preview.population.frozen.reference, preview.population.frozen.included])) {
            throw new BoardError("The activity behind this report's counts changed. Prepare a new report.", 409);
        }
    }
    async function contextFor(state, selected, options, selection) {
        if (!options.recordedContext || !selected.length) return null;
        return collectReportContext(session, state, mergeEvidenceWithState(state), selected, selection?.promptAuthors);
    }
    async function assertContext(preview, state, selected, { locked = false } = {}) {
        if (!preview.contextDependencies) return;
        const source = JSON.stringify(reportContextSource(session, state));
        const current = await contextFor(state, selected, preview.options, preview.selection);
        if (current.dependencies !== preview.contextDependencies) throw new BoardError("Recorded report context changed or became unavailable. Prepare a new preview and disclosure review.", 409);
        const latest = locked ? state : await loadBoardState(session);
        if (preview.evidenceFrame) {
            const captured = capturedReportState(latest, preview, { records: state.evidence });
            assertSelected(preview, captured, selectedRecords(captured, preview));
            assertEvaluation(preview, captured);
        } else if (latest.revision !== state.revision || source !== JSON.stringify(reportContextSource(session, latest))) {
            throw new BoardError("Report context authority changed while reading. Prepare a fresh preview.", 409);
        }
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
    function assertPeriod(preview, current) {
        if (!preview.periodDependencies) return;
        if (JSON.stringify(reportContextSource(session, current)) !== preview.periodSource) {
            throw new BoardError("The comparison source or permission changed. Return to Compare periods and prepare a new report.", 409);
        }
        assertPeriodApiParents(current, preview.periodApiParents);
        for (const evaluationDependencies of preview.periodDependencies) assertEvaluation({ evaluationDependencies }, current);
        const refs = [...new Set(preview.periodDependencies.flatMap(dependency => dependency.interactionRefs))];
        const model = buildAssessmentModel(current, { source: reportContextSource(session, current) });
        if (periodAssessmentSignature(current, model, refs) !== preview.periodAssessmentSignature) {
            throw new BoardError("Selected comparison findings or assessment coverage changed. Prepare a new comparison report.", 409);
        }
    }
    async function assertComparison(preview, current) {
        if (preview.invalidationKey !== invalidationKey(current)) throw new BoardError("Comparison approval became stale after a data or permission change.", 409);
        assertSavedReportDependencies(preview.sourceDependencies, current);
        const pair = await inspectComparisonPair(session, current, preview.sourceDependencies[0].bundleId, preview.sourceDependencies[1].bundleId, preview.comparisonOptions);
        if (JSON.stringify(pair.dependencies) !== JSON.stringify(preview.sourceDependencies)) throw new BoardError("A saved source report changed. Prepare a new comparison.", 409);
        if (JSON.stringify(pair.comparison) !== JSON.stringify(preview.bundle.comparison)
            || JSON.stringify(pair.sourceFacts) !== JSON.stringify(preview.bundle.snapshot.sourceFacts)) {
            throw new BoardError("The reviewed comparison no longer matches its frozen source facts.", 409);
        }
    }
    function comparisonPreview(owner, previewId) {
        const preview = previews.get(previewId);
        if (!preview || preview.owner !== owner || preview.kind !== "comparison") throw new BoardError("Comparison preview is no longer available.", 409);
        return preview;
    }
    const api = {
        async preview(owner, selection, input = {}, collectionSelection, pairedInput, services = {}) {
            const { semanticSelection, resolveSemantic } = services;
            const inherited = services.rebuildFrom === undefined ? null : previews.get(services.rebuildFrom);
            discard(owner);
            if (services.rebuildFrom !== undefined && (!inherited || inherited.owner !== owner
                || inherited.kind !== "report" || !inherited.population || inherited.nativeFrame || inherited.periodDependencies
                || Date.now() > inherited.expires || selection !== undefined || collectionSelection !== undefined || pairedInput !== undefined)) {
                discard(owner);
                throw new BoardError("This report can no longer be updated from its prepared activity. Choose its activity again.", 409);
            }
            if (inherited) {
                const next = normalizeReportOptions(input);
                const membership = options => JSON.stringify([options.reportFocus, options.dateSelection, options.timeContext, options.saveMode]);
                if (membership(next) !== membership(inherited.options)) {
                    discard(owner);
                    throw new BoardError("The report's activity choices changed. Prepare it from the updated selection.", 409);
                }
            }
            collectionSelection = collectionSelection === undefined ? undefined : structuredClone(collectionSelection);
            const generation = Symbol();
            generations.set(owner, generation);
            try {
            let state = await loadBoardState(session);
            assertNativeReportRuntime(state, services.nativeReportSource, session);
            const options = normalizeReportOptions(input);
            if (inherited) {
                state = await readReportState(state, inherited);
                assertSelected(inherited, state, selectedRecords(state, inherited));
                assertPopulation(inherited, state);
                assertEvaluation(inherited, state);
                collectionSelection = {
                    kind: "selected", revision: state.revision, scenarioIds: [...inherited.population.scenarioIds],
                    ...(inherited.selection?.promptAuthors ? { promptAuthors: [...inherited.selection.promptAuthors] } : {}),
                };
            }
            const scenarios = mergeEvidenceWithState(state);
            if (pairedInput !== undefined && (selection !== undefined || collectionSelection !== undefined)) throw new BoardError("A paired comparison cannot be combined with ordinary report selection.", 422);
            if (semanticSelection !== undefined && pairedInput === undefined) throw new BoardError("Search membership requires a paired report input.", 422);
            let nativeFrame, nativeSource, nativeProjection, nativeMembership;
            if (pairedInput?.nativeViewId !== undefined) {
                const captured = await readNativePeriodView(services, periodReportInput(pairedInput, semanticSelection),
                    value => ({ frame: value.frame, projection: value.projection, membership: value.membership }));
                nativeFrame = captured.frame; nativeProjection = captured.projection; nativeSource = services.nativeReportSource;
                nativeMembership = captured.membership;
            }
            const accepted = pairedInput === undefined ? null : acceptPeriodReport(state, pairedInput, {
                source: reportContextSource(session, state), semanticSelection, resolveSemantic,
                ...(pairedInput.nativeViewId === undefined ? {} : { nativeRecords: nativeProjection?.records ?? [] }),
                ...(nativeMembership ? { nativeMembership } : {}),
            });
            if (accepted) {
                const ids = [...new Set(Object.values(accepted.value.periods).flatMap(side => side.scenarioIds))];
                collectionSelection = { kind: "selected", revision: state.revision, scenarioIds: ids,
                    promptAuthors: accepted.value.options.filters?.promptAuthors };
            }
            if (collectionSelection !== undefined && selection !== undefined) throw new BoardError("Choose one report selection method.", 422);
            if (services.reportView !== undefined) {
                if (inherited || !options.reportFocus || collectionSelection?.kind !== "current"
                    || collectionSelection.revision !== state.revision || pairedInput !== undefined || selection !== undefined
                    || services.resolveNativeReportView !== undefined) {
                    throw new BoardError("Analyze-derived reports require a current qualified interaction view.", 409);
                }
                collectionSelection.scenarioIds = resolveReportView(scenarios, services.reportView, options,
                    (receipt, layer) => resolveSemantic?.(receipt, state, layer));
                if (!collectionSelection.scenarioIds.length) throw new BoardError("No saved interactions match these choices. Try a wider date range or another filter.", 422);
            }
            const ready = scenarios.filter((s) => s.workflowState === "ready_to_export");
            if (collectionSelection === undefined && selection !== undefined && (!Array.isArray(selection) || !selection.length || selection.length > 500 || new Set(selection).size !== selection.length || selection.some((id) => !ready.some((s) => s.scenarioId === id)))) {
                throw new BoardError("Selection must contain unique ready scenario IDs.");
            }
            const resolvingNativeView = services.resolveNativeReportView !== undefined;
            if (resolvingNativeView) {
                if (typeof services.resolveNativeReportView !== "function" || collectionSelection === undefined
                    || pairedInput !== undefined || selection !== undefined
                    || services.nativeRecords !== undefined || services.nativeDefinitions !== undefined) {
                    throw new BoardError("Use one original native view and an independent GitHub selection for this report.", 422);
                }
                validateExportSelection(collectionSelection, state.revision, { allowEmpty: true });
                const { source, admission } = nativeServices(services, owner);
                const view = await services.resolveNativeReportView({ kind: collectionSelection.kind, revision: collectionSelection.revision });
                validateNativeView(view, collectionSelection, state);
                if (generations.get(owner) !== generation) throw new BoardError("Preview was cancelled or replaced. No files were written.", 409);
                if (view.frame !== null) {
                    nativeFrame = view.frame;
                    nativeSource = source;
                    nativeProjection = await assembleNativeFrame(nativeFrame, source, admission, null, owner, generation);
                }
            }
            let snapshotSelection = collectionSelection === undefined ? null : selectExportSnapshot(scenarios, collectionSelection, state.revision,
                resolvingNativeView || pairedInput?.nativeViewId !== undefined ? { nativeConversationCount: nativeProjection?.records.length ?? 0 }
                    : { nativeRecords: services.nativeRecords ?? [] });
            let population;
            if (options.reportFocus) {
                if (!snapshotSelection || accepted || nativeProjection?.records.length || snapshotSelection.nativeRecords?.length) {
                    throw new BoardError("These report presets need qualified originating interactions. Use the existing source report entry for other evidence.", 422);
                }
                const selectedPopulation = selectReportPopulation(snapshotSelection.records, options);
                if (!selectedPopulation.records.length) {
                    throw new BoardError("No saved interactions match these choices. Try a wider date range or another filter.", 422);
                }
                population = {
                    scenarioIds: selectedPopulation.reference.map(entry => entry.scenarioId),
                    frozen: freezeReportPopulation(selectedPopulation, state.pseudonymKey),
                };
                if (inherited) {
                    population.frozen.undatedInteractions = inherited.population.frozen.undatedInteractions;
                    if (JSON.stringify([population.frozen.reference, population.frozen.included])
                        !== JSON.stringify([inherited.population.frozen.reference, inherited.population.frozen.included])) {
                        throw new BoardError("The report's prepared activity changed. Choose its activity again.", 409);
                    }
                }
                snapshotSelection = { ...snapshotSelection, records: selectedPopulation.records,
                    scope: { ...(inherited?.bundle.snapshot.selectionScope ?? snapshotSelection.scope),
                        ...summarizeExportSelection(buildExportCatalog(selectedPopulation.records)) } };
            }
            const chosen = snapshotSelection?.records ?? (selection ? ready.filter((s) => selection.includes(s.scenarioId)) : ready);
            const nativeChosen = snapshotSelection?.nativeRecords ?? [];
            if (!chosen.length && !nativeChosen.length && !nativeProjection?.records.length) throw new BoardError("No cards are ready to export.");
            for (const [id, p] of previews) if (Date.now() > p.expires || p.owner === owner) {
                previews.delete(id);
                if (reviewedGenerations.get(p.owner) === p.generation) reviewedGenerations.delete(p.owner);
            }
            if (previews.size >= 32) throw new BoardError("Too many pending previews. Close or confirm an existing preview.", 409);
            const previewId = randomUUID();
            const preparedAt = new Date().toISOString();
            if (nativeProjection && options.dateSelection.range !== "capture") {
                throw new BoardError("Native dated cohorts are not qualified. Prepare a report of the original view's retained conversations without a report date range.", 422);
            }
            if (nativeChosen.length) {
                if (collectionSelection.kind !== "selected") {
                    throw new BoardError("Native All and Current report membership requires the bounded source-selection contract. Choose an explicitly selected conversation set.", 503);
                }
                if (pairedInput !== undefined || options.dateSelection.range !== "capture") {
                    throw new BoardError("Native dated cohorts are not qualified. Prepare a report of the selected retained conversations without a report date range.", 422);
                }
                const { source, admission } = nativeServices(services, owner);
                const expected = nativeReportSelectionExpectations(nativeChosen, services.nativeDefinitions, state.pseudonymKey);
                if (typeof source.captureSelection !== "function" || typeof source.iterateSelection !== "function") {
                    throw new BoardError("Native report preparation requires the bounded committed-selection runtime.", 503);
                }
                nativeFrame = await source.captureSelection({ revision: state.revision,
                    sources: [...new Set(nativeChosen.map(record => record.sourceId))],
                    scenarioIds: nativeChosen.map(record => record.scenarioId) }, admission);
                nativeProjection = await assembleNativeFrame(nativeFrame, source, admission, expected, owner, generation);
                nativeSource = source;
            }
            if (accepted && JSON.stringify(options.timeContext) !== JSON.stringify(accepted.value.timeContext)) {
                throw new BoardError("The comparison timezone or locale changed. Return to Compare periods.", 409);
            }
            if (accepted && options.dateSelection.range !== "capture") throw new BoardError("Paired report dates are fixed to the accepted comparison.", 422);
            if (accepted && (chosen.length !== collectionSelection.scenarioIds.length
                || chosen.some(record => !collectionSelection.scenarioIds.includes(record.scenarioId)))) {
                throw new BoardError("This comparison contains records outside the eligible report boundary. Change its scope in Compare periods; no records were silently omitted.", 422);
            }
            const range = time.range(options.dateSelection, options.timeContext.timeZone);
            const period = accepted ? freezePeriodReport(state, accepted, preparedAt) : null;
            const assessed = period || !chosen.length ? null : evaluation.buildReportFacts(chosen, state, { preparedAt, scope: {
                kind: snapshotSelection?.scope.kind ?? "selected", from: range.from ?? null, untilExclusive: range.to ?? null, timeZone: options.timeContext.timeZone,
            } });
            const context = await contextFor(state, chosen, options, collectionSelection);
            const fingerprint = selectedFingerprint(state, chosen);
            const verification = { selection: collectionSelection, scenarioIds: chosen.map(record => record.scenarioId),
                evidenceFrame: inherited?.evidenceFrame ?? await captureEvidenceFrame(state, chosen), selectedFingerprint: fingerprint,
                options, population, contextDependencies: context?.dependencies, evaluationDependencies: assessed?.dependencies };
            const bundle = await buildSanitizedBundle(disclosureRecords(state, chosen, collectionSelection), state.pseudonymKey, input, pdfRenderer,
                period ? undefined : snapshotSelection?.scope, assessed?.facts, context, period?.frozen, nativeProjection, population?.frozen);
            if (generations.get(owner) !== generation) throw new BoardError("Preview was cancelled or replaced. No files were written.", 409);
            const current = await readReportState(await loadBoardState(session), verification);
            const selected = selectedRecords(current, verification);
            assertSelected({ selectedFingerprint: fingerprint }, current, selected);
            assertPopulation(verification, current);
            if (rescan(current, selected, collectionSelection, nativeProjection).inputFingerprint !== bundle.privacy.inputFingerprint) throw new BoardError("Selected evidence changed while rendering. Prepare a new preview.", 409);
            await assertContext(verification, current, selected);
            assertEvaluation({ evaluationDependencies: assessed?.dependencies }, current);
            const periodState = period ? { periodDependencies: period.dependencies, periodApiParents: period.apiParents, periodSource: JSON.stringify(reportContextSource(session, state)),
                periodAssessmentSignature: periodAssessmentSignature(state, accepted.model, [...new Set(period.dependencies.flatMap(dependency => dependency.interactionRefs))]) } : {};
            assertPeriod(periodState, current);
            const preview = {
                kind: "report", owner, revision: state.revision, scenarioIds: chosen.map((s) => s.scenarioId),
                generation,
                selection: collectionSelection,
                evidenceFrame: verification.evidenceFrame,
                options, population, contextDependencies: context?.dependencies,
                selectedFingerprint: fingerprint,
                evaluationDependencies: assessed?.dependencies, ...periodState,
                contextRequired: input.timeContext !== undefined,
                expires: Date.now() + 10 * 60_000, bundle,
                ...(nativeFrame ? { nativeFrame, nativeSource, nativeProjection } : {}),
            };
            return await publishNative(preview, services, () => {
                if (generations.get(owner) !== generation) throw new BoardError("Preview was cancelled or replaced. No files were written.", 409);
                previews.set(previewId, preview);
                reviewedGenerations.set(owner, generation);
                return { previewId, revision: state.revision, expiresInSeconds: 600,
                    ...(preview.evidenceFrame ? { collectedSourceFrozen: true } : {}), ...publicBundle(bundle) };
            });
            } finally {
                if (generations.get(owner) === generation) generations.delete(owner);
            }
        },
        async review(owner, previewId, disclosureReviewed, timeContext, services = {}) {
            if (disclosureReviewed !== true) throw new BoardError("Explicit disclosure-review attestation is required.", 428);
            const preview = previews.get(previewId);
            if (!preview || preview.owner !== owner) throw new BoardError("Preview not found for this panel. Prepare a new privacy scan.", 409);
            checkTime(preview, timeContext);
            const current = await readReportState(await loadBoardState(session), preview);
            assertNativeReportRuntime(current, services.nativeReportSource, session);
            if (Date.now() > preview.expires) throw new BoardError("Preview expired. Prepare a new privacy scan and disclosure review.", 409);
            if (preview.kind === "comparison") {
                if (preview.savedComparisonFrame) {
                    const { source, admission } = nativeServices(services, owner, preview);
                    await source.withSavedComparison(preview.savedComparisonFrame, admission, visible => assertComparison(preview, visible));
                } else await assertComparison(preview, current);
            }
            else {
                const selected = selectedRecords(current, preview);
                assertSelected(preview, current, selected);
                assertPopulation(preview, current);
                if (!preview.selection && selected.some((s) => s.workflowState !== "ready_to_export")) throw new BoardError("Selection or content changed. Prepare a new privacy scan and disclosure review.", 409);
                const rescanned = rescan(current, selected, preview.selection, preview.nativeProjection);
                if (rescanned.inputFingerprint !== preview.bundle.privacy.inputFingerprint) throw new BoardError("Selected content changed. Privacy rescan and review are required.", 409);
                await assertContext(preview, current, selected);
                assertEvaluation(preview, current);
                assertPeriod(preview, current);
            }
            const publish = () => {
                if (previews.get(previewId) !== preview) throw new BoardError("Preview was cancelled or replaced. Prepare a new review.", 409);
                preview.bundle.privacy = { ...preview.bundle.privacy, reviewerConfirmed: true, reviewChannel: "explicit-disclosure-attestation", confirmedAt: new Date().toISOString() };
                const manifest = JSON.parse(preview.bundle.files["coverage-and-redaction-manifest.json"]);
                manifest.privacyReview = preview.bundle.privacy;
                preview.bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
                preview.bundle.projectionScan = assertProjectedBundle(preview.bundle);
                preview.reviewed = true;
                return { previewId, revision: preview.revision,
                    ...(preview.evidenceFrame ? { collectedSourceFrozen: true } : {}), ...publicBundle(preview.bundle) };
            };
            if (preview.savedComparisonFrame) {
                const { source, admission } = nativeServices(services, owner, preview);
                return source.withSavedComparison(preview.savedComparisonFrame, admission, publish);
            }
            return publishNative(preview, services, publish);
        },
        async confirm(owner, previewId, confirmed, timeContext, services = {}) {
            if (confirmed !== true || typeof previewId !== "string") throw new BoardError("Explicit local export confirmation is required.");
            const preview = previews.get(previewId);
            if (!preview || preview.owner !== owner) throw new BoardError("Preview not found for this panel. Prepare a new preview.", 409);
            checkTime(preview, timeContext);
            const localMode = (preview.options ?? preview.comparisonOptions)?.saveMode === "local";
            if (localMode) {
                const manifest = JSON.parse(preview.bundle.files["coverage-and-redaction-manifest.json"]);
                try { preview.bundle.privacy = confirmReportLocalSave(manifest, services.localSave); }
                catch (error) {
                    if (!(error instanceof TypeError)) throw error;
                    throw new BoardError(error.message, 428);
                }
                manifest.privacyReview = preview.bundle.privacy;
                preview.bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
                preview.bundle.projectionScan = assertProjectedBundle(preview.bundle);
                preview.localSaveConfirmed = true;
            } else {
                if (services.localSave !== undefined) throw new BoardError("Prepare a report with the current save controls before using this confirmation.", 422);
                if (!preview.reviewed) throw new BoardError("Complete explicit disclosure review in the preview before confirming export.", 428);
            }
            previews.delete(previewId);
            let written, writerEntered = false;
            try {
                const validate = async (current, assertCurrent = () => {}) => {
                    assertCurrent();
                    current = await readReportState(current, preview);
                    assertCurrent();
                    if (preview.owner !== owner || confirmed !== true
                        || (localMode ? preview.localSaveConfirmed !== true || !preview.bundle.privacy?.localSave : !preview.reviewed)
                        || !hasReportSaveAuthorization(preview.bundle.privacy)
                        || (preview.nativeFrame || preview.savedComparisonFrame) && reviewedGenerations.get(owner) !== preview.generation) {
                        throw new BoardError("The original reviewed preview is no longer current for this panel.", 409);
                    }
                    checkTime(preview, timeContext);
                    if (Date.now() > preview.expires || preview.kind !== "comparison" && !preview.selection && preview.scenarioIds.some((id) => current.cards[id]?.workflowState !== "ready_to_export")) {
                        throw new BoardError("Board changed or preview expired. Prepare a new preview.", 409);
                    }
                    if (preview.kind === "comparison") await assertComparison(preview, current);
                    else {
                        const selected = selectedRecords(current, preview);
                        assertSelected(preview, current, selected);
                        assertPopulation(preview, current);
                        if (rescan(current, selected, preview.selection, preview.nativeProjection).inputFingerprint !== preview.bundle.privacy.inputFingerprint) throw new BoardError("Selected content changed; a fresh privacy review is required.", 409);
                        await assertContext(preview, current, selected, { locked: true });
                        assertEvaluation(preview, current);
                        assertPeriod(preview, current);
                    }
                    assertProjectedBundle(preview.bundle);
                    assertCurrent();
                };
                const work = async (current, assertCurrent = () => {}) => {
                    await validate(current, assertCurrent);
                    assertArtifactWritable(current, preview.bundle.bundleId, preview.bundle.kind ?? "report");
                    assertCurrent();
                    writerEntered = true;
                    written = await writer(session, preview.bundle, current, { assertCurrent });
                    assertCurrent();
                    if (preview.kind !== "comparison") written.scenarioIds = preview.scenarioIds;
                    current.exports.push(written);
                    current.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
                    current.artifactDeletion.revision += 1;
                };
                if (preview.savedComparisonFrame) {
                    const { source, admission } = nativeServices(services, owner, preview);
                    await source.withSavedComparison(preview.savedComparisonFrame, admission, async (visible, assertCurrent, actual) => {
                        await validate(visible, assertCurrent);
                        assertArtifactWritable(actual, preview.bundle.bundleId, "comparison");
                        writerEntered = true;
                        written = await writer(session, preview.bundle, actual, { assertCurrent });
                        assertCurrent();
                        actual.exports.push(written);
                        actual.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
                        actual.artifactDeletion.revision++;
                    }, { bundle: preview.bundle, validate });
                    return source.readSaved({ bundleIds: null }, admission, (state, entries, assertCurrent) => {
                        assertCurrent();
                        const bundle = entries.find(entry => entry.bundleId === written.bundleId);
                        if (!bundle) throw new BoardError("Saved Microsoft comparison is no longer authorized.", 403);
                        return { bundle, state };
                    });
                }
                if (preview.nativeFrame) {
                    const { source, admission } = nativeServices(services, owner, preview);
                    await source.commit(preview.nativeFrame, admission, work, { bundle: preview.bundle, validate });
                    return await source.readSaved({ bundleIds: null }, admission, (state, entries, assertCurrent) => {
                        assertCurrent();
                        const bundle = entries.find(entry => entry.bundleId === written.bundleId);
                        if (!bundle) throw new BoardError("Saved native report is no longer authorized. Reload saved reports before continuing.", 403);
                        return { bundle, state };
                    });
                }
                const commit = () => updateBoardState(session, async current => {
                    assertNativeReportRuntime(current, services.nativeReportSource, session);
                    await work(current);
                });
                const { state } = await (services.commitMutation ? services.commitMutation(commit) : commit());
                if (state.nativeReportPolicy !== undefined) {
                    const { source, admission } = nativeServices(services, owner);
                    return await source.readSaved({ bundleIds: null }, admission, (current, entries) => ({
                        bundle: entries.find(entry => entry.bundleId === written.bundleId), state: current,
                    }));
                }
                return { bundle: written, state };
            } catch (error) {
                // The branded source only publishes through work; crossing the writer
                // boundary is ambiguous even if the writer never returns a receipt.
                if (preview.nativeFrame && !writerEntered && error && typeof error === "object") {
                    nativeSaveRefusals.set(error, { controller: api, session, owner,
                        disposition: { outcome: "not-published", kind: "report", previewId, bundleId: preview.bundle.bundleId } });
                }
                if (writerEntered && (preview.nativeFrame || preview.savedComparisonFrame)) {
                    const failure = new BoardError("Report publication began, but the final save or authorized readback could not be confirmed. Check saved reports before continuing; do not repeat the save.", 500);
                    failure.code = "NATIVE_REPORT_SAVE_UNCONFIRMED";
                    failure.cause = error;
                    throw failure;
                }
                if (written) throw new BoardError(`Bundle files were written to ${written.bundleDir}, but export-history commit failed. Source and review labels are unchanged. Reload state before continuing.`, 500);
                throw error;
            } finally {
                if (reviewedGenerations.get(owner) === preview.generation) reviewedGenerations.delete(owner);
            }
        },
        async inspectComparison(owner, baselineId, laterId, input = {}, services = {}) {
            const state = await loadBoardState(session);
            assertNativeReportRuntime(state, services.nativeReportSource, session);
            if (services.nativeReportSource || state.exports.some(entry => [baselineId, laterId].includes(entry.bundleId) && entry.nativeEvidenceHash)) {
                const { source, admission } = nativeServices(services, owner);
                return source.readSaved({ bundleIds: [baselineId, laterId] }, admission, async (current, entries, assertCurrent, actual) => {
                    const pair = await inspectComparisonPair(session, current, baselineId, laterId, input);
                    assertCurrent();
                    if (!actual) throw new BoardError("Locked report state is unavailable.", 503);
                    assertSavedReportDependencies(pair.dependencies, actual);
                    return restrictSavedArtifactMetadata({ comparison: pair.comparison, sources: pair.sources }, actual);
                });
            }
            const pair = await inspectComparisonPair(session, state, baselineId, laterId, input);
            const current = await loadBoardState(session);
            assertSavedReportDependencies(pair.dependencies, current);
            return { comparison: pair.comparison, sources: pair.sources };
        },
        async previewComparison(owner, baselineId, laterId, input = {}, services = {}) {
            discard(owner);
            const settings = normalizeComparisonOptions(input);
            const options = { ...(settings.title !== undefined ? { title: settings.title } : {}), formats: settings.formats,
                timeContext: settings.timeContext, cohort: settings.cohort,
                ...(settings.resultText ? { resultText: true } : {}), manualTerms: settings.manualTerms,
                ...(settings.saveMode === "local" ? { saveMode: "local" } : {}) };
            const generation = { sourceIds: [baselineId, laterId] };
            generations.set(owner, generation);
            try {
                const state = await loadBoardState(session);
                assertNativeReportRuntime(state, services.nativeReportSource, session);
                for (const [id, pending] of previews) if (Date.now() > pending.expires) {
                    previews.delete(id);
                    if (reviewedGenerations.get(pending.owner) === pending.generation) reviewedGenerations.delete(pending.owner);
                }
                if (previews.size >= 32) throw new BoardError("Too many pending previews. Close an existing preview.", 409);
                let pair;
                if (services.nativeReportSource) {
                    const { source, admission } = nativeServices(services, owner);
                    pair = await source.readSaved({ bundleIds: [baselineId, laterId] }, admission,
                        async (visible, entries, assertCurrent, actual) => {
                            const inspected = await inspectComparisonPair(session, visible, baselineId, laterId, options);
                            assertCurrent();
                            if (!actual) throw new BoardError("Locked report state is unavailable.", 503);
                            assertSavedReportDependencies(inspected.dependencies, actual);
                            return restrictSavedArtifactMetadata(inspected, actual);
                        });
                } else pair = await inspectComparisonPair(session, state, baselineId, laterId, options);
                const bundle = await buildComparisonBundle(pair, options, pdfRenderer);
                let native;
                if (bundle.comparison.nativeComparison) {
                    const { source, admission } = nativeServices(services, owner);
                    native = { nativeSource: source, savedComparisonFrame: await source.captureSavedComparison(pair.dependencies, admission), generation };
                }
                const previewId = randomUUID(), preview = {
                    kind: "comparison", owner, revision: state.revision, sourceDependencies: pair.dependencies,
                    comparisonOptions: options, invalidationKey: invalidationKey(state),
                    contextRequired: input.timeContext !== undefined, expires: Date.now() + 10 * 60_000, bundle, ...native,
                };
                if (generations.get(owner) !== generation) throw new BoardError("Comparison preview was cancelled or replaced.", 409);
                if (native) {
                    const { source, admission } = nativeServices(services, owner, preview);
                    await source.withSavedComparison(preview.savedComparisonFrame, admission, visible => assertComparison(preview, visible));
                } else await assertComparison(preview, await loadBoardState(session));
                if (generations.get(owner) !== generation) throw new BoardError("Comparison preview was cancelled or replaced.", 409);
                previews.set(previewId, preview);
                if (native) reviewedGenerations.set(owner, generation);
                return { previewId, revision: state.revision, expiresInSeconds: 600, ...publicBundle(bundle) };
            } finally {
                if (generations.get(owner) === generation) generations.delete(owner);
            }
        },
        async reviewComparison(owner, previewId, confirmed, context, services = {}) {
            comparisonPreview(owner, previewId);
            return api.review(owner, previewId, confirmed, context, services);
        },
        async confirmComparison(owner, previewId, confirmed, context, services = {}) {
            comparisonPreview(owner, previewId);
            return api.confirm(owner, previewId, confirmed, context, services);
        },
        async openComparison(owner, bundleId) {
            return openSavedComparison(session, await loadBoardState(session), bundleId);
        },
        invalidateSavedReport(bundleId) {
            for (const [id, preview] of previews) if (preview.sourceDependencies?.some(source => source.bundleId === bundleId)) previews.delete(id);
            for (const [owner, generation] of generations) if (generation?.sourceIds?.includes(bundleId)) generations.delete(owner);
        },
        invalidateDerived() { previews.clear(); generations.clear(); reviewedGenerations.clear(); },
        cancel(owner, previewId) {
            if (previews.get(previewId)?.owner === owner) {
                const preview = previews.get(previewId);
                previews.delete(previewId);
                if (reviewedGenerations.get(owner) === preview.generation) reviewedGenerations.delete(owner);
            }
        },
        discardAll() { previews.clear(); generations.clear(); reviewedGenerations.clear(); },
        discard,
    };
    reviewedNativeControllers.set(api, { session, preview: api.preview, review: api.review, confirm: api.confirm });
    return api;
}
