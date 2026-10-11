import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BoardError, loadBoardState, mergeEvidenceWithState, moveCard, resolveDataDir, exclusiveBoard } from "./store.mjs";
import { renderHtmlShell } from "./render.mjs";
import { refreshHistory, recordMetadata, coverageFor } from "./collection.mjs";
import { buildActivityAnalytics as buildAnalytics, buildRequestActivity } from "./activity-analytics.mjs";
import { validateAnalyticsInput } from "./analytics-input.mjs";
import { buildExportCatalog } from "./export-selection.mjs";
import { createCollector, collectorFor, collectionSummary } from "./collector.mjs";
import { createCollectionStatus } from "./collection-status.mjs";
import { chatCopy } from "./chat-copy.mjs";
import { createRecorderDiagnostics } from "./recorder-diagnostics.mjs";
import { createDeletionController } from "./deletion.mjs";
import { createRecollectionController } from "./recollection.mjs";
import { logoSvg } from "./branding.mjs";
import { REQUESTS } from "./assessment-contract.mjs";
import { executeAssessmentAction, assessmentError, assessmentStatus } from "./assessment.mjs";
import { cachedAssessmentModel, invalidateAssessmentCache, finalizePersonalEvaluationCleanup } from "./assessment-read-model.mjs";
import { selectPersonalEvaluationCleanup } from "./personal-evaluation.mjs";
import { createSavedArtifactDescriptor, describeSavedArtifact, readSavedReportDocument, readSavedArtifactFile } from "./report-artifacts.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";
import { createEvaluationController } from "./evaluation-controller.mjs";
import { createAutomaticScoreController } from "./automatic-score-controller.mjs";
import { buildPeriodComparison, validatePeriodComparisonInput } from "./period-comparison.mjs";

const assessmentRoutes = {
    "/api/assessment/detail": "get_interaction", "/api/assessment/overview": "get_assessment_overview",
    "/api/assessment/consent": "get_assessment_consent", "/api/assessment/evidence": "get_interaction_evidence",
    "/api/assessment/feedback": "set_personal_assessment", "/api/assessment/consent/set": "set_assessment_consent",
    "/api/assessment/mutation/status": "get_mutation_status",
};
const browserModules = Object.freeze({
    "/assets/assessment-contract.mjs": "./assessment-contract.mjs",
    "/assets/period-comparison-math.mjs": "./period-comparison-math.mjs",
    "/assets/report-outcome-comparison.mjs": "./report-outcome-comparison.mjs",
    "/assets/report-metric-comparison.mjs": "./report-metric-comparison.mjs",
    "/assets/wire-report-metric-adapter.mjs": "./wire-report-metric-adapter.mjs",
});

function sessionCatalog(state, scenarios) {
    const roster = state.importCoverage?.roster ?? [];
    const issues = new Map(createCollectionStatus().coverage(roster, roster, scenarios.map(s => s.sourceSessionId)).issues.map(row => [row.sessionId, row]));
    const sources = new Map();
    for (const scenario of scenarios) if (scenario.sourceSessionId && !sources.has(scenario.sourceSessionId)) sources.set(scenario.sourceSessionId, {
        sessionId: scenario.sourceSessionId, name: scenario.sourceSessionName || (["copilot-app", "copilot-app-chat"].includes(scenario.sourceHost) ? chatCopy.unnamed : "Source name not recorded"),
        projectId: scenario.projectId, project: scenario.project, eligible: !scenario.collectionInactive && !scenario.isLegacy,
        disposition: scenario.currentSourceDisposition || "preserved-evidence", coverageKnown: false,
    });
    for (const source of roster) if (source.sessionId) sources.set(source.sessionId, {
        sessionId: source.sessionId, name: source.name || sources.get(source.sessionId)?.name || chatCopy.unnamed,
        projectId: source.projectId, project: source.project, projectType: source.projectType,
        eligible: source.eligible === true, disposition: source.disposition, coverageKnown: true,
        scanned: source.scanned === true, pending: !source.error && (!source.scanned || (source.cursor?.backlogBytes ?? 0) > (source.cursor?.partialBytes ?? 0)),
        reasons: issues.get(source.sessionId)?.reasons ?? [], unavailable: issues.get(source.sessionId)?.unavailable ?? false,
    });
    return [...sources.values()];
}

export async function currentStatePayload(session, state, config = { layer: "tool", groupBy: "endpoint", filters: { scope: "history" }, limit: 10 }) {
    state ??= await loadBoardState(session);
    const scenarios = mergeEvidenceWithState(state);
    const { requests, excluded } = buildExportCatalog(scenarios);
    const model = cachedAssessmentModel(state, collectorFor(session)?.assessmentSource(state));
    return {
        boardId: state.boardId, revision: state.revision, deletionVersion: activityDeletionVersion(state),
        artifactRevision: state.artifactDeletion?.revision ?? 0, scenarios,
        coverage: coverageFor(state, scenarios),
        analytics: { ...buildAnalytics(scenarios, config), revision: state.revision },
        requestActivity: buildRequestActivity(scenarios),
        sessions: sessionCatalog(state, scenarios),
        sessionAnalysis: config.filters?.sourceSessionIds?.length === 1
            ? { ...buildAnalytics(scenarios, { ...config, filters: { ...config.filters, outcomes: undefined } }), revision: state.revision } : null,
        continuation: state.continuation, exports: state.exports,
        assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: model.overview,
            consent: model.consent, source: model.source, capabilities: model.capabilities },
        exportCatalog: { requests, excluded },
        collection: collectorFor(session) ? collectionSummary(await collectorFor(session).status(state.revision)) : null,
    };
}

function validateObject(input, allowed, required = []) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) {
        throw new BoardError("Invalid action arguments.");
    }
}

export async function executeAction(session, exports, owner, action, input, services = {}) {
    if (action === "qualify_response_timing") {
        const collector = collectorFor(session);
        if (!collector) throw new BoardError("Collection is not attached to this runtime.", 503);
        return collector.qualifyResponseTimings(input);
    }
    if (Object.hasOwn(REQUESTS, action)) {
        const run = () => executeAssessmentAction(session, owner, action, input, {
            source: state => collectorFor(session)?.assessmentSource(state) ?? state.personalEvaluation?.source,
            commitCaptureRevocation: services.deletion?.commitCaptureRevocation,
            invalidateDerived: () => { exports.invalidateDerived?.(); exports.discardAll(); },
        });
        return action === "set_assessment_consent" && services.coordinateAssessment ? services.coordinateAssessment(run) : run();
    }
    if (["collection_status", "configure_collection", "set_collection_enabled", "collect_now"].includes(action)) {
        const collector = collectorFor(session);
        if (!collector) throw new BoardError("Collection is not attached to this runtime.", 503);
        if (action === "configure_collection") return collector.configure(input);
        if (action === "set_collection_enabled") {
            validateObject(input, ["enabled", "expectedConfigVersion"], ["enabled"]);
            return collector.setEnabled(input.enabled, input.expectedConfigVersion);
        }
        validateObject(input, action === "collection_status" ? ["details"] : []);
        if (action === "collection_status") {
            const pending = await exclusiveBoard(session, state => state.deletion?.pending ? {
                state: "cleanup-pending", revision: state.revision, deletionVersion: activityDeletionVersion(state),
                artifactRevision: state.artifactDeletion?.revision ?? 0,
                assessment: assessmentStatus(state),
            } : null);
            if (pending) return pending;
        }
        const status = action === "collect_now" ? await collector.collectNow() : await collector.status();
        const assessment = await exclusiveBoard(session, assessmentStatus);
        return { ...(input.details === true ? status : collectionSummary(status)), assessment };
    }
    if (action === "get_period_comparison") {
        validatePeriodComparisonInput(input);
        const state = await loadBoardState(session);
        if (input.semanticSelection && !services.search?.membership) throw new BoardError("search-membership-unavailable", 409);
        const semanticMembership = input.semanticSelection ? services.search.membership(owner, input.semanticSelection.receipt, state, input.options.layer ?? "tool") : undefined;
        return buildPeriodComparison(state, input, { model: cachedAssessmentModel(state, collectorFor(session)?.assessmentSource(state)), semanticMembership });
    }
    if (action === "get_analytics" || action === "get_snapshot") {
        validateAnalyticsInput(input);
        const state = await loadBoardState(session);
        if (action === "get_snapshot") return currentStatePayload(session, state, input);
        return { ...buildAnalytics(mergeEvidenceWithState(state), input), revision: state.revision };
    }
    if (action === "get_summary") {
        validateObject(input, []);
        const data = await currentStatePayload(session);
        return { boardId: data.boardId, revision: data.revision, coverage: data.coverage, exports: data.exports };
    }
    if (action === "refresh_history") {
        validateObject(input, []);
        return currentStatePayload(session, await refreshHistory(session));
    }
    if (action === "record_graph_metadata") {
        validateObject(input, ["confirmed"], ["confirmed"]);
        return currentStatePayload(session, await recordMetadata(session, input.confirmed));
    }
    if (action === "get_state" || action === "reload_snapshot") {
        validateObject(input, []);
        return currentStatePayload(session);
    }
    if (action === "move_card") {
        validateObject(input, ["scenarioId", "toState"], ["scenarioId", "toState"]);
        return currentStatePayload(session, await moveCard(session, input.scenarioId, input.toState));
    }
    if (action === "preview_export") {
        exports.discard(owner);
        validateObject(input, ["scenarioIds", "options", "selection", "periodComparison", "semanticSelection"]);
        if (input.selection !== undefined && input.scenarioIds !== undefined) throw new BoardError("Choose one report selection method.", 422);
        if (input.periodComparison !== undefined && (input.selection !== undefined || input.scenarioIds !== undefined)) throw new BoardError("Choose either the accepted comparison or an ordinary report selection.", 422);
        if (input.semanticSelection !== undefined && input.periodComparison === undefined) throw new BoardError("Search membership requires a paired report input.", 422);
        return exports.preview(owner, input.scenarioIds, input.options, input.selection, input.periodComparison, {
            semanticSelection: input.semanticSelection,
            resolveSemantic: (receipt, state, layer) => {
                if (!services.search?.membership) throw new BoardError("search-membership-unavailable", 409);
                return services.search.membership(owner, receipt, state, layer);
            },
        });
    }
    if (action === "confirm_export") {
        validateObject(input, ["previewId", "confirmed", "timeContext"], ["previewId", "confirmed"]);
        const result = await exports.confirm(owner, input.previewId, input.confirmed, input.timeContext);
        return { bundle: result.bundle, state: await currentStatePayload(session, result.state) };
    }
    throw new BoardError("Unknown action.", 404);
}

function send(res, status, object) {
    const body = JSON.stringify(object);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}

async function readBody(req) {
    let data = "";
    for await (const chunk of req) {
        data += chunk;
        if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new BoardError("Request body is too large. Narrow the report selection.", 413);
    }
    try { return JSON.parse(data); }
    catch { throw new BoardError("A valid JSON object is required."); }
}

export async function startServer(session, exports, options = {}) {
    const recorderDiagnostics = createRecorderDiagnostics(session, options.recorderDiagnostics);
    const evaluation = createEvaluationController(session, {
        getSourceConfig: () => {
            const collector = collectorFor(session);
            if (!collector) throw new BoardError("An approved local source is required for evaluation.", 428);
            return collector.approvedRecollectionSource();
        },
        onChanged: () => { exports.invalidateDerived?.(); exports.discardAll(); },
        ...options.evaluation,
    });
    const automaticScores = createAutomaticScoreController(session, {
        evaluation,
        getSourceConfig: () => {
            const collector = collectorFor(session);
            if (!collector) throw new BoardError("Connect an approved local source first.", 428);
            return collector.approvedRecollectionSource();
        },
        onChanged: () => { invalidateAssessmentCache(); exports.invalidateDerived?.(); exports.discardAll(); },
    });
    const deletion = createDeletionController(session, {
        coordinateRecorder: work => recorderDiagnostics.exclusiveActivity(work),
        selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup,
        describeSavedArtifact: createSavedArtifactDescriptor(session),
        ...options.deletion,
        async onSeal(state, operation) {
            invalidateAssessmentCache();
            if (operation.kind === "artifact-deletion") {
                for (const artifact of operation.artifacts ?? [operation.artifact]) exports.invalidateSavedReport?.(artifact?.artifactId ?? operation.artifactId);
            }
            else { exports.invalidateDerived?.(); exports.discardAll(); }
            if (operation.kind === "activity-deletion") await evaluation.sealSourceDeletion(state);
            await options.deletion?.onSeal?.(state, operation);
        },
    });
    const recollection = createRecollectionController(session, {
        coordinateRecorder: work => recorderDiagnostics.exclusiveActivity(work),
        onCommitted() { invalidateAssessmentCache(); exports.invalidateDerived?.(); exports.discardAll(); },
    });
    const services = { deletion, coordinateAssessment: work => recorderDiagnostics.exclusiveActivity(() => collectorFor(session)?.exclusiveActivity(work) ?? work()) };
    const sessions = new Map();
    const nonce = randomBytes(24).toString("hex");
    const runtimeId = randomUUID();
    const ttlMs = options.sessionTtlMs ?? 30 * 60 * 1000;
    const routes = { ...assessmentRoutes, "/api/period-comparison": "get_period_comparison", "/api/assessment/response-timing/qualify": "qualify_response_timing", "/api/collection/status": "collection_status", "/api/collection/configure": "configure_collection", "/api/collection/enabled": "set_collection_enabled", "/api/collection/now": "collect_now", "/api/analytics": "get_analytics", "/api/snapshot": "get_snapshot", "/api/refresh": "reload_snapshot", "/api/import": "refresh_history", "/api/record": "record_graph_metadata", "/api/move": "move_card", "/api/preview": "preview_export", "/api/export": "confirm_export" };
    let origin;
    let ready = false;
    function discard(capability) {
        const entry = sessions.get(capability);
        if (entry) exports.discard(entry.owner);
        sessions.delete(capability);
    }
    function prune() {
        for (const [capability, entry] of sessions) if (Date.now() - entry.lastUsed >= ttlMs) discard(capability);
    }
    function issue() {
        prune();
        if (sessions.size >= 128) throw new BoardError("Too many active local panels. Close unused panels or wait for inactive panel connections to expire.", 429);
        const capability = randomBytes(32).toString("hex");
        sessions.set(capability, { owner: randomUUID(), lastUsed: Date.now() });
        return capability;
    }
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline'; font-src data:; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'self'`);
        try {
            if (!origin || req.headers.host !== new URL(origin).host) throw new BoardError("Forbidden host.", 403);
            if (req.headers.origin && req.headers.origin !== origin) throw new BoardError("Foreign origin denied.", 403);
            if (!ready) throw new BoardError("Local evidence runtime is initializing.", 503);
            if (req.method === "GET" && req.url === "/health") return send(res, 200, { service: "workiq-evidence", protocol: 1, runtimeId });
            if (req.method === "GET" && Object.hasOwn(browserModules, req.url)) {
                const bytes = await readFile(new URL(browserModules[req.url], import.meta.url));
                res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": bytes.length });
                return res.end(bytes);
            }
            if (req.method === "GET" && req.url === "/favicon.svg") {
                res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Length": Buffer.byteLength(logoSvg) });
                return res.end(logoSvg);
            }
            if (req.method === "GET" && req.url === "/") {
                const html = renderHtmlShell(issue(), nonce);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                return res.end(html);
            }
            if (req.method === "POST") {
                if (req.headers.origin !== origin) throw new BoardError("Same-origin writes only.", 403);
                if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new BoardError("JSON content type required.", 415);
                if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") throw new BoardError("Same-origin requests only.", 403);
            }
            if (req.method === "POST" && req.url === "/api/session") {
                validateObject(await readBody(req), []);
                return send(res, 200, { capability: issue(), runtimeId });
            }
            prune();
            const capability = req.headers["x-board-capability"];
            const entry = typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability) ? sessions.get(capability) : undefined;
            if (!entry) return send(res, 403, { code: "session_expired", error: "Local panel connection expired. Reconnect before continuing; actions were not replayed." });
            entry.lastUsed = Date.now();
            if (req.method === "GET" && req.url === "/api/state") return send(res, 200, await currentStatePayload(session));
            if (req.method !== "POST") throw new BoardError("Method not allowed.", 405);
            const input = await readBody(req);
            if (req.url === "/api/artifact-deletion/preview") {
                if (input?.scope === "all-reports") validateObject(input, ["scope"], ["scope"]);
                else validateObject(input, ["artifactKind", "artifactId"], ["artifactKind", "artifactId"]);
                if (!deletion.previewArtifact) throw new BoardError("Saved-artifact deletion is not attached.", 503);
                return send(res, 200, await deletion.previewArtifact(entry.owner, input));
            }
            if (req.url === "/api/artifact-deletion/confirm") {
                validateObject(input, ["operationId", "confirmed"], ["operationId", "confirmed"]);
                if (!deletion.confirmArtifact) throw new BoardError("Saved-artifact deletion is not attached.", 503);
                return send(res, 200, await deletion.confirmArtifact(entry.owner, input));
            }
            if (req.url === "/api/artifact-deletion/status") {
                validateObject(input, ["operationId", "receiptToken"], ["operationId"]);
                if (input.receiptToken !== undefined && (typeof input.receiptToken !== "string" || !/^[a-f0-9]{64}$/.test(input.receiptToken))) throw new BoardError("Invalid artifact receipt capability.", 422);
                return send(res, 200, await deletion.status(input.operationId, entry.owner, input.receiptToken));
            }
            if (req.url === "/api/artifact-deletion/cancel") {
                validateObject(input, ["operationId"], ["operationId"]);
                return send(res, 200, deletion.cancel(entry.owner, input.operationId));
            }
            if (req.url === "/api/report-artifacts/list") {
                validateObject(input, []);
                const state = await loadBoardState(session);
                return send(res, 200, { artifacts: state.exports.map(item => describeSavedArtifact(item, state)) });
            }
            if (req.url === "/api/evaluation/automatic/setup") {
                return send(res, 200, await automaticScores.setup(input));
            }
            if (req.url === "/api/evaluation/automatic/summary") {
                validateObject(input, []);
                return send(res, 200, await automaticScores.summary());
            }
            if (req.url === "/api/evaluation/automatic/approve") return send(res, 200, await automaticScores.approve(entry.owner, input));
            if (req.url === "/api/evaluation/automatic/revoke") return send(res, 200, await automaticScores.revoke(entry.owner, input));
            if (req.url === "/api/evaluation/automatic/status") return send(res, 200, await automaticScores.status(entry.owner, input));
            if (req.url === "/api/evaluation/setup") return send(res, 200, await evaluation.setup(input));
            if (req.url === "/api/evaluation/start") return send(res, 200, await evaluation.start(entry.owner, input));
            if (req.url === "/api/evaluation/status") return send(res, 200, await evaluation.status(entry.owner, input));
            if (req.url === "/api/evaluation/revoke") {
                validateObject(input, ["confirmed"], ["confirmed"]);
                if (input.confirmed !== true) throw new BoardError("Confirm turning off evaluation first.", 422);
                return send(res, 200, await evaluation.revoke());
            }
            if (req.url === "/api/report-comparison/inspect" || req.url === "/api/report-comparison/preview") {
                const inspect = req.url.endsWith("/inspect");
                validateObject(input, inspect ? ["baselineId", "laterId", "cohort"] : ["baselineId", "laterId", "cohort", "formats", "timeContext"], ["baselineId", "laterId"]);
                const method = inspect ? "inspectComparison" : "previewComparison";
                if (!exports[method]) throw new BoardError("Saved comparison is not attached.", 503);
                const { baselineId, laterId, ...settings } = input;
                return send(res, 200, await exports[method](entry.owner, baselineId, laterId, settings));
            }
            if (req.url === "/api/report-comparison/review") {
                validateObject(input, ["previewId", "disclosureReviewed", "timeContext"], ["previewId", "disclosureReviewed"]);
                return send(res, 200, await exports.reviewComparison(entry.owner, input.previewId, input.disclosureReviewed, input.timeContext));
            }
            if (req.url === "/api/report-comparison/save") {
                validateObject(input, ["previewId", "confirmed", "timeContext"], ["previewId", "confirmed"]);
                const result = await exports.confirmComparison(entry.owner, input.previewId, input.confirmed, input.timeContext);
                return send(res, 200, { bundle: result.bundle, state: await currentStatePayload(session, result.state) });
            }
            if (req.url === "/api/report-comparison/cancel") {
                validateObject(input, ["previewId"], ["previewId"]);
                exports.cancel(entry.owner, input.previewId);
                return send(res, 200, { cancelled: true });
            }
            if (req.url === "/api/report-comparison/open") {
                validateObject(input, ["bundleId"], ["bundleId"]);
                return send(res, 200, await exports.openComparison(entry.owner, input.bundleId));
            }
            if (req.url === "/api/recollection/sources") {
                validateObject(input, []);
                return send(res, 200, await recollection.sources());
            }
            if (req.url === "/api/recollection/preview") return send(res, 200, await recollection.preview(entry.owner, input));
            if (req.url === "/api/recollection/confirm") return send(res, 200, await recollection.confirm(entry.owner, input));
            if (req.url === "/api/recollection/status") return send(res, 200, await recollection.status(entry.owner, input));
            if (req.url === "/api/recollection/cancel") return send(res, 200, recollection.cancel(entry.owner, input));
            if (req.url === "/api/deletion/preview") return send(res, 200, await deletion.preview(entry.owner, input));
            if (req.url === "/api/deletion/confirm") {
                const result = await deletion.confirm(entry.owner, input);
                if (result.phase === "complete") exports.discardAll();
                return send(res, 200, result);
            }
            if (req.url === "/api/deletion/status") {
                validateObject(input, ["operationId"], ["operationId"]);
                return send(res, 200, await deletion.status(input.operationId));
            }
            if (req.url === "/api/deletion/cancel") {
                validateObject(input, ["operationId"], ["operationId"]);
                return send(res, 200, deletion.cancel(entry.owner, input.operationId));
            }
            if (req.url === "/api/record") {
                validateObject(input, ["confirmed", "attemptId"], ["confirmed", "attemptId"]);
                return send(res, 200, await recorderDiagnostics.start(input));
            }
            if (req.url === "/api/record/status") {
                validateObject(input, ["attemptId"]);
                return send(res, 200, await recorderDiagnostics.status(input.attemptId));
            }
            if (req.url === "/api/session/release") {
                validateObject(input, []);
                discard(capability);
                return send(res, 200, { released: true });
            }
            if (req.url === "/api/privacy-review") {
                validateObject(input, ["previewId", "disclosureReviewed", "timeContext"], ["previewId", "disclosureReviewed"]);
                return send(res, 200, await exports.review(entry.owner, input.previewId, input.disclosureReviewed, input.timeContext));
            }
            if (req.url === "/api/cancel-preview") {
                validateObject(input, ["previewId"], ["previewId"]);
                exports.cancel(entry.owner, input.previewId);
                return send(res, 200, { cancelled: true });
            }
            if (req.url === "/api/report/open") {
                validateObject(input, ["bundleId"], ["bundleId"]);
                const result = await exclusiveBoard(session, state => readSavedReportDocument(session, state, input.bundleId));
                return send(res, 200, result);
            }
            if (req.url === "/api/artifact-file") {
                validateObject(input, ["bundleId", "kind", "format"], ["bundleId", "kind", "format"]);
                const { bytes, ...identity } = await exclusiveBoard(session, state =>
                    readSavedArtifactFile(session, state, input.bundleId, input.kind, input.format), { readOnly: true });
                return send(res, 200, { ...identity, data: bytes.toString("base64"), encoding: "base64" });
            }
            if (req.url === "/api/report-file") {
                validateObject(input, ["bundleId", "name"], ["bundleId", "name"]);
                const state = await loadBoardState(session);
                const bundle = state.exports.find((b) => b.bundleId === input.bundleId);
                const file = bundle?.files?.[input.name];
                const root = path.join(resolveDataDir(session), "exports");
                if (!file || typeof file !== "string" || !path.resolve(file).startsWith(root + path.sep) || path.basename(file) !== input.name) throw new BoardError("Saved report file not found. Previews cannot be downloaded as exports.", 404);
                const bytes = await readFile(file);
                return send(res, 200, { name: input.name, data: bytes.toString("base64"), encoding: "base64" });
            }
            if (req.url === "/api/canvas") {
                validateObject(input, ["action", "input"], ["action", "input"]);
                return send(res, 200, await executeAction(session, exports, entry.owner, input.action, input.input, services));
            }
            if (!routes[req.url]) throw new BoardError("Not found.", 404);
            return send(res, 200, await executeAction(session, exports, entry.owner, routes[req.url], input, services));
        } catch (error) {
            error = assessmentError(error);
            if (!(error instanceof BoardError)) console.error("[workiq-runtime] operation failed", { code: typeof error.code === "string" ? error.code : "INTERNAL" });
            if (!res.headersSent && !res.destroyed) send(res, error instanceof BoardError ? error.status : 500, {
                ...(error.code ? { code: error.code } : {}),
                error: error instanceof BoardError ? error.message : "Local board operation failed. No success was recorded; read state before retrying.",
            });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port: options.port ?? 47831, host: "127.0.0.1", exclusive: true }, resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    let collector;
    try {
        // Acquire the fixed listening endpoint before any state initialization/writes.
        collector = await createCollector(session, {
            ...options.collector,
            onCommitted: async check => {
                if (ready) await automaticScores.reconcile();
                await options.collector?.onCommitted?.(check);
            },
        });
        await deletion.recover();
        await evaluation.recover();
        await automaticScores.recover();
        await loadBoardState(session);
        ready = true;
        await automaticScores.reconcile();
    } catch (error) {
        if (collector) await collector.close();
        await new Promise(resolve => server.close(resolve));
        throw error;
    }
    const closeServer = server.close;
    server.close = function (callback) {
        ready = false;
        closeServer.call(server, error => {
            automaticScores.close().then(() => Promise.all([collector.close(), recorderDiagnostics.close(), evaluation.close()]))
                .then(() => callback?.(error), failure => callback?.(failure));
        });
        return server;
    };
    server.on("close", () => { for (const capability of sessions.keys()) discard(capability); });
    return {
        server, collector, url: `${origin}/`, runtimeId,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}
