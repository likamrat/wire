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
import { validateBackfillCheckpoint } from "./collector-backfill.mjs";
import { createRecollectionController } from "./recollection.mjs";
import { logoSvg } from "./branding.mjs";
import { REQUESTS } from "./assessment-contract.mjs";
import { executeAssessmentAction, assessmentError, assessmentStatus } from "./assessment.mjs";
import { cachedAssessmentModel, invalidateAssessmentCache, finalizePersonalEvaluationCleanup } from "./assessment-read-model.mjs";
import { selectPersonalEvaluationCleanup } from "./personal-evaluation.mjs";
import { createSavedArtifactDescriptor, describeSavedArtifact, readSavedReportDocument, readSavedArtifactFile, readLegacyReportOriginal, assertLegacyReportOriginalCurrent } from "./report-artifacts.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";
import { cleanupDeletedEvaluationWork, readEvaluationReceipt } from "./evaluation-controller.mjs";
import { readAutomaticScoreReceipt } from "./automatic-score-controller.mjs";
import { rejectAIReview, rejectPersonalFeedback } from "./ai-review-retirement.mjs";
import { buildPeriodComparison, validatePeriodComparisonInput } from "./period-comparison.mjs";
import { readNativePeriodView } from "./native-report-stream.mjs";
import { createLiveSearch } from "./live-search.mjs";
import { nativeRetentionDiagnostic } from "./native-read-model.mjs";
import { assertNativeReportRuntime } from "./native-persistence.mjs";
import { openSavedComparison } from "./comparison-export.mjs";
import { projectInteractionModels } from "./interaction-model.mjs";
import { createGitHubProfile } from "./github-profile.mjs";
import { createGitHubProfileRoutes, GITHUB_PROFILE_PATH } from "./github-profile-http.mjs";
import { microsoftProfileView } from "./microsoft-profile.mjs";
import { ACCESS_PATHS, ACCESS_TIMING, assertRuntimeAccess } from "./runtime-access.mjs";
import { nativeReportSelection } from "./retained-population.mjs";
import { withNativeArtifactMutation } from "./native-artifact-mutation.mjs";
import { restrictSavedArtifactMetadata } from "./runtime-artifact-metadata.mjs";
import { isReviewedNativeReportController, takeNativeSaveRefusal } from "./export.mjs";
import { assertReleasedRequest } from "./release-policy.mjs";
import { DEFAULT_RUNTIME_PORT } from "./runtime-endpoint.mjs";

const assessmentRoutes = {
    "/api/assessment/detail": "get_interaction", "/api/assessment/overview": "get_assessment_overview",
    "/api/assessment/consent": "get_assessment_consent", "/api/assessment/evidence": "get_interaction_evidence",
    "/api/assessment/feedback": "set_personal_assessment", "/api/assessment/consent/set": "set_assessment_consent",
    "/api/assessment/mutation/status": "get_mutation_status",
};
const browserModules = Object.freeze({
    "/assets/assessment-contract.mjs": "./assessment-contract.mjs",
    "/assets/period-comparison-math.mjs": "./period-comparison-math.mjs",
    "/assets/report-result-contract.mjs": "./report-result-contract.mjs",
    "/assets/report-outcome-comparison.mjs": "./report-outcome-comparison.mjs",
    "/assets/report-metric-comparison.mjs": "./report-metric-comparison.mjs",
    "/assets/wire-report-metric-adapter.mjs": "./wire-report-metric-adapter.mjs",
    "/assets/marked.mjs": "../node_modules/marked/lib/marked.esm.js",
    "/assets/pdf.mjs": "../node_modules/pdfjs-dist/build/pdf.mjs",
    "/assets/pdf.worker.mjs": "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
});
const searchSafeReads = new Set([
    ...Object.entries(assessmentRoutes).filter(([, action]) => action.startsWith("get_")).map(([route]) => route),
    "/api/period-comparison", "/api/collection/status", "/api/collection/sources/status", "/api/collection/microsoft/status",
    "/api/collection/microsoft/enrollment",
    "/api/analytics", "/api/snapshot", "/api/refresh",
    "/api/artifact-deletion/status", "/api/report-artifacts/list", "/api/evaluation/automatic/status",
    "/api/artifact-deletion/eligibility",
    "/api/evaluation/status", "/api/report-comparison/inspect", "/api/report-comparison/open",
    "/api/recollection/sources", "/api/recollection/status", "/api/deletion/status", "/api/record/status",
    "/api/report/open", "/api/report-original", "/api/report-file", "/api/artifact-file", "/api/session/release",
    "/api/preview", "/api/privacy-review", "/api/cancel-preview",
    "/api/report-comparison/preview", "/api/report-comparison/review", "/api/report-comparison/cancel",
]);
const nativePublicationStatus = services => services.nativeReportPublication?.()
    ?? { schemaVersion: 1, available: false, reason: "runtime-unqualified" };

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

async function nativeCollectionFields(services, input = {}) {
    const fields = {
        ...(services.nativeCollectionControl ? { nativeControl: await services.nativeCollectionControl() } : {}),
        ...(services.nativePersistenceStatus ? { nativePersistence: await services.nativePersistenceStatus(
            Object.hasOwn(input, "operationId") ? { operationId: input.operationId } : {}) } : {}),
    };
    if (services.nativeConfigurationOffer) {
        const offer = await services.nativeConfigurationOffer();
        if (fields.nativeControl && offer.authorizationRevision !== fields.nativeControl.revision) {
            throw Object.assign(new BoardError("Microsoft configuration changed while its controls were read. Read current status again.", 409),
                { code: "NATIVE_CONFIGURATION_CONTROL_STALE" });
        }
        fields.nativeConfigurationOffer = offer;
        if (fields.nativeControl) fields.nativeControl = { ...fields.nativeControl,
            canResume: fields.nativeControl.canResume && fields.nativePersistence?.configured === true };
    }
    return fields;
}

async function sourceAwareCollectionStatus(session, services) {
    if ((!services.sourceAware && !services.copilotOnly) || !services.globalCollectionControl || !collectorFor(session)
        || !services.copilotOnly && (!services.nativePersistenceStatus || !services.nativeConfigurationOffer)) {
        throw Object.assign(new BoardError("Source-aware collection status is not attached.", 503),
            { code: "SOURCE_AWARE_COLLECTION_UNAVAILABLE" });
    }
    const before = await services.globalCollectionControl();
    const github = collectionSummary(await collectorFor(session).status());
    const native = services.copilotOnly ? null : await nativeCollectionFields(services);
    const current = await services.globalCollectionControl();
    const gate = current.globalCollection, offer = native?.nativeConfigurationOffer;
    if (before.generation !== current.generation || before.authorizationRevision !== current.authorizationRevision
        || native && (native.nativeControl?.revision !== current.authorizationRevision
        || native.nativePersistence?.generation !== current.generation
        || offer.generation !== current.generation || offer.authorizationRevision !== current.authorizationRevision
        || offer.globalRevision !== (gate?.revision ?? null))) {
        throw Object.assign(new BoardError("Collection authority changed while source status was read.", 409),
            { code: "SOURCE_AWARE_COLLECTION_STALE" });
    }
    const githubActions = ["configure"];
    if (github.config?.approved) {
        githubActions.push("set-interval");
        if (services.manualCollectionAvailable?.()) githubActions.push("collect-now");
    }
    const microsoftActions = [];
    if (offer?.available) microsoftActions.push("configure");
    if (native?.nativePersistence.actions.includes("collect-now")) microsoftActions.push("collect-now");
    if (native?.nativeControl.enabled && native.nativeControl.canPause) microsoftActions.push("pause");
    if (native && !native.nativeControl.enabled && native.nativeControl.canResume && native.nativePersistence.configured) microsoftActions.push("resume");
    return {
        schemaVersion: 1, kind: "source-aware-collection", generation: current.generation,
        authorizationRevision: current.authorizationRevision,
        global: gate === null ? { state: "legacy-compatible", revision: null, actions: ["pause", "resume"] }
            : { state: "committed", revision: gate.revision, paused: gate.paused, actions: [gate.paused ? "resume" : "pause"] },
        github: { status: github, actions: githubActions },
        ...(native ? { microsoft: { status: native.nativePersistence, configurationOffer: offer, actions: microsoftActions } } : {}),
    };
}

async function readReportState(session, services, bundleIds, work) {
    if (services.nativeReportSource) {
        return services.nativeReportSource.readSaved({ bundleIds }, services.nativeReportAdmission,
            async (state, entries, assertCurrent, actual) => {
                if (!actual) throw Object.assign(new BoardError("Locked report state is unavailable.", 503),
                    { code: "NATIVE_REPORT_LOCKED_STATE_REQUIRED" });
                assertNativeReportRuntime(actual, services.nativeReportSource, session);
                const value = await work(state, assertCurrent, actual);
                assertCurrent();
                return restrictSavedArtifactMetadata(value, actual);
            });
    }
    return exclusiveBoard(session, state => {
        assertNativeReportRuntime(state, undefined, session);
        return work(state, () => {}, state);
    }, { readOnly: true });
}

async function boundedNativeSnapshot(state, config, services) {
    if (!services.nativeRetained || !services.nativePersistenceStatus) throw Object.assign(
        new BoardError("The bounded Microsoft reader is not attached.", 503), { code: "NATIVE_VIEW_BINDING_REQUIRED" });
    const status = await services.nativePersistenceStatus({});
    if (status.revision !== state.revision) throw Object.assign(
        new BoardError("Native metadata changed while the snapshot was read.", 409), { code: "NATIVE_REPORT_SNAPSHOT_STALE" });
    if (status.kind === "native-account-unavailable") return { status: "unavailable", reason: status.reason,
        revision: state.revision, generation: status.generation, authorizationRevision: status.authorizationRevision };
    if (!status.configured) return { status: "unavailable", reason: "native-retention-not-configured", revision: state.revision };
    try {
        return { status: "bounded", ...await services.nativeRetained.query({
            schemaVersion: 1, revision: state.revision, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
            analytics: config, page: { limit: config.limit ?? 10, after: null },
        }) };
    } catch (error) {
        if (error.code !== "NATIVE_REPORT_COMMITTED_SOURCE_REQUIRED") throw error;
        return { status: "unavailable", reason: "native-retained-source-not-committed", revision: state.revision };
    }
}

export async function currentStatePayload(session, state, config = { layer: "tool", groupBy: "endpoint", filters: { scope: "history" }, limit: 10 }, nativeReader, services = {}) {
    state ??= await loadBoardState(session);
    assertNativeReportRuntime(state, services.nativeReportSource, session);
    const bounded = services.sourceAware ? await boundedNativeSnapshot(state, config, services) : null;
    const legacy = mergeEvidenceWithState(state), native = bounded ? null : await nativeReader?.scan();
    const nativeUnavailable = native?.kind === "native-account-unavailable";
    const nativeAvailable = native && !nativeUnavailable;
    const scenarios = [...legacy, ...native?.records ?? []];
    const { requests, excluded } = buildExportCatalog(legacy);
    const model = cachedAssessmentModel(state, collectorFor(session)?.assessmentSource(state));
    const analytics = { ...buildAnalytics(scenarios, config), revision: state.revision, ...(bounded ? { native: bounded } : {}) };
    const payload = {
        boardId: state.boardId, revision: state.revision, deletionVersion: activityDeletionVersion(state),
        artifactRevision: state.artifactDeletion?.revision ?? 0, scenarios: [...projectInteractionModels(legacy), ...native?.records ?? []],
        coverage: { ...coverageFor(state, legacy), ...(nativeAvailable ? { totalScenarios: scenarios.length,
            native: { conversations: native.records.length, activityDates: "unqualified", services: "unqualified",
                sourceVerification: "historical-only", status: "preparation-only" } } : {}),
            ...(bounded ? { native: bounded.status === "bounded"
                ? { status: "bounded", aggregates: bounded.aggregates, coverage: bounded.coverage }
                : { status: "unavailable", reason: bounded.reason } } : {}) },
        analytics,
        requestActivity: buildRequestActivity(scenarios),
        sessions: sessionCatalog(state, scenarios),
        sessionAnalysis: config.filters?.sourceSessionIds?.length === 1
            ? { ...buildAnalytics(scenarios, { ...config, filters: { ...config.filters, outcomes: undefined } }), revision: state.revision } : null,
        continuation: state.continuation, exports: [],
        assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: model.overview,
            consent: model.consent, source: model.source, capabilities: model.capabilities },
        exportCatalog: { requests, excluded: { ...excluded, ...(nativeAvailable ? {
            nativeProvenanceUnqualifiedRequestGroups: native.records.length,
        } : {}) }, ...(nativeAvailable ? { blockedRequests: native.records.map(record => ({
            scenarioId: record.scenarioId, sourceId: record.sourceId,
            code: "native-report-provenance-unqualified",
            reason: "Native report dependencies are not qualified. No report can be prepared from this conversation.",
        })) } : {}) },
        ...(native ? { nativeRead: nativeUnavailable ? {
            status: "unavailable", reason: native.reason, revision: native.revision,
            generation: native.generation, authorizationRevision: native.authorizationRevision,
        } : { status: "preparation-only", revision: native.revision,
            definitions: native.definitions, admission: native.admission,
            ...(native.readback ? { generation: native.generation, readback: native.readback } : {}),
            reportSelection: nativeReportSelection(scenarios, analytics) } } : {}),
        ...(bounded ? { nativeRead: bounded } : {}),
        ...(services.sourceAware ? { nativeReportPublication: nativePublicationStatus(services) } : {}),
        collection: collectorFor(session) ? {
            ...collectionSummary(await collectorFor(session).status(state.revision)),
            ...(services.sourceAware || services.copilotOnly ? { sourceAware: await sourceAwareCollectionStatus(session, services) }
                : await nativeCollectionFields(services)),
        } : null,
    };
    if (services.nativeReportSource) {
        return readReportState(session, services, null, (visible, assertCurrent, actual) => {
            if (actual.revision !== state.revision) throw Object.assign(new BoardError("Snapshot changed while reports were read.", 409),
                { code: "NATIVE_REPORT_SNAPSHOT_STALE" });
            if (native) {
                if (typeof nativeReader.assertCurrent !== "function") throw Object.assign(
                    new BoardError("Synchronous native publication is unavailable.", 503), { code: "NATIVE_REPORT_PUBLICATION_REQUIRED" });
                const checked = nativeReader.assertCurrent(native);
                if (checked && typeof checked.then === "function") Promise.resolve(checked).catch(() => {});
                if (checked !== true) throw Object.assign(new BoardError("Native snapshot is no longer current.", 409),
                    { code: "NATIVE_REPORT_SNAPSHOT_STALE" });
            }
            assertCurrent();
            return { ...payload, exports: visible.exports };
        });
    }
    payload.exports = state.exports;
    return native ? nativeReader.publish(native, () => payload) : payload;
}

function validateObject(input, allowed, required = []) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) {
        throw new BoardError("Invalid action arguments.");
    }
}

export async function executeAction(session, exports, owner, action, input, services = {}) {
    if (action === "set_personal_assessment") rejectPersonalFeedback();
    if (action === "qualify_interaction_models") {
        const collector = collectorFor(session);
        if (!collector) throw new BoardError("Collection is not attached to this runtime.", 503);
        return collector.qualifyInteractionModels(input);
    }
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
        if (action === "configure_collection") return collector.configure(input, services.collectionAdmission);
        if (action === "set_collection_enabled") {
            validateObject(input, ["enabled", "expectedConfigVersion"], ["enabled"]);
            return collector.setEnabled(input.enabled, input.expectedConfigVersion, services.collectionAdmission);
        }
        validateObject(input, action === "collection_status"
            ? ["details", ...(!services.sourceAware && services.nativePersistenceStatus ? ["operationId"] : [])] : ["expectedBasis"]);
        if (action === "collection_status") {
            const pending = await exclusiveBoard(session, state => state.deletion?.pending ? {
                state: "cleanup-pending", revision: state.revision, deletionVersion: activityDeletionVersion(state),
                artifactRevision: state.artifactDeletion?.revision ?? 0,
                assessment: assessmentStatus(state),
            } : null);
            if (pending) return pending;
        }
        const status = action === "collect_now" ? await collector.collectNow(services.collectionAdmission, input.expectedBasis) : await collector.status();
        const assessment = await exclusiveBoard(session, assessmentStatus);
        return { ...(input.details === true ? status : collectionSummary(status)), assessment,
            ...(!services.sourceAware ? await nativeCollectionFields(services, input) : {}) };
    }
    if (action === "get_period_comparison") {
        validatePeriodComparisonInput(input);
        if (input.nativeViewId !== undefined) {
            return readNativePeriodView(services, input, ({ state, projection, membership }) => {
                if (input.semanticSelection && !services.search?.membership) throw new BoardError("search-membership-unavailable", 409);
                const semanticMembership = input.semanticSelection ? services.search.membership(owner, input.semanticSelection.receipt, state, input.options.layer ?? "tool") : undefined;
                return buildPeriodComparison(state, input, {
                    model: cachedAssessmentModel(state, collectorFor(session)?.assessmentSource(state)),
                    nativeRecords: projection?.records ?? [], nativeMembership: membership, semanticMembership,
                });
            });
        }
        if (services.sourceAware && (!(input.options?.filters?.sources ?? []).length
            || input.options.filters.sources.some(source => source.startsWith("microsoft-")))) {
            throw Object.assign(new BoardError("Microsoft period comparison requires its original complete source view. Read current activity or select GitHub Copilot explicitly.", 503),
                { code: "NATIVE_PERIOD_COMPARISON_UNAVAILABLE" });
        }
        const state = await loadBoardState(session);
        const native = services.sourceAware ? null : await services.nativeReader?.scan();
        if (input.semanticSelection && !services.search?.membership) throw new BoardError("search-membership-unavailable", 409);
        const semanticMembership = input.semanticSelection ? services.search.membership(owner, input.semanticSelection.receipt, state, input.options.layer ?? "tool", native) : undefined;
        const selected = new Set(semanticMembership
            ? [...semanticMembership.scenarioIds, ...semanticMembership.parentScenarioIds] : input.scenarioIds);
        const value = buildPeriodComparison(state, input, { model: cachedAssessmentModel(state, collectorFor(session)?.assessmentSource(state)),
            scenarios: [...mergeEvidenceWithState(state), ...(native?.records ?? []).filter(record => selected.has(record.scenarioId))], semanticMembership });
        return native ? services.nativeReader.publish(native, () => value) : value;
    }
    if (action === "get_analytics" || action === "get_snapshot") {
        validateAnalyticsInput(input);
        const state = await loadBoardState(session);
        if (action === "get_snapshot") return currentStatePayload(session, state, input, services.nativeReader, services);
        const native = services.sourceAware ? null : await services.nativeReader?.scan();
        const bounded = services.sourceAware ? await boundedNativeSnapshot(state, input, services) : null;
        const value = { ...buildAnalytics([...mergeEvidenceWithState(state), ...native?.records ?? []], input), revision: state.revision,
            ...(bounded ? { native: bounded } : {}) };
        if (bounded) return readReportState(session, services, [], (_visible, assertCurrent, actual) => {
            if (actual.revision !== state.revision) throw Object.assign(new BoardError("Analytics changed before publication.", 409),
                { code: "NATIVE_REPORT_SNAPSHOT_STALE" });
            assertCurrent();
            return value;
        });
        return native ? services.nativeReader.publish(native, () => value) : value;
    }
    if (action === "get_summary") {
        validateObject(input, []);
        const data = await currentStatePayload(session, undefined, undefined, services.nativeReader, services);
        return { boardId: data.boardId, revision: data.revision, coverage: data.coverage, exports: data.exports,
            ...(services.sourceAware ? { nativeRead: data.nativeRead } : {}) };
    }
    if (action === "refresh_history") {
        validateObject(input, []);
        return currentStatePayload(session, await refreshHistory(session), undefined, services.nativeReader, services);
    }
    if (action === "record_graph_metadata") {
        validateObject(input, ["confirmed"], ["confirmed"]);
        return currentStatePayload(session, await recordMetadata(session, input.confirmed), undefined, services.nativeReader, services);
    }
    if (action === "get_state" || action === "reload_snapshot") {
        validateObject(input, []);
        return currentStatePayload(session, undefined, undefined, services.nativeReader, services);
    }
    if (action === "move_card") {
        validateObject(input, ["scenarioId", "toState"], ["scenarioId", "toState"]);
        const work = () => moveCard(session, input.scenarioId, input.toState);
        const state = await (services.commitMutation ? services.commitMutation(work) : work());
        return currentStatePayload(session, state, undefined, services.nativeReader, services);
    }
    if (action === "preview_export") {
        exports.discard(owner);
        validateObject(input, ["scenarioIds", "options", "selection", "periodComparison", "semanticSelection", "nativeViewId"]);
        if (input.selection !== undefined && input.scenarioIds !== undefined) throw new BoardError("Choose one report selection method.", 422);
        if (input.periodComparison !== undefined && (input.selection !== undefined || input.scenarioIds !== undefined)) throw new BoardError("Choose either the accepted comparison or an ordinary report selection.", 422);
        if (input.semanticSelection !== undefined && input.periodComparison === undefined) throw new BoardError("Search membership requires a paired report input.", 422);
        let selection = input.selection, resolveNativeReportView;
        if (Object.hasOwn(input, "nativeViewId")) {
            if (typeof input.nativeViewId !== "string" || !/^[a-f0-9]{64}$/.test(input.nativeViewId)
                || !selection || !["all", "current", "selected"].includes(selection.kind)
                || input.periodComparison !== undefined || input.semanticSelection !== undefined
                || !Number.isSafeInteger(selection.revision) || selection.revision < 0
                || selection.kind === "all" && selection.scenarioIds !== undefined
                || selection.kind !== "all" && (!Array.isArray(selection.scenarioIds)
                    || selection.scenarioIds.some(id => typeof id !== "string")
                    || new Set(selection.scenarioIds).size !== selection.scenarioIds.length)) {
                throw new BoardError("A native report requires its original bounded view and an exact selection.", 422);
            }
            if (!services.sourceAware || typeof services.nativeReportViewResolver !== "function") {
                throw Object.assign(new BoardError("The accepted native report view resolver is not attached.", 503),
                    { code: "native-report-provenance-unqualified" });
            }
            const state = await loadBoardState(session);
            if (state.revision !== selection.revision) throw new BoardError("The accepted report view changed. Read a fresh view.", 409);
            const legacy = new Set(mergeEvidenceWithState(state).map(record => record.scenarioId));
            const githubIds = [], nativeIds = [];
            for (const id of selection.scenarioIds ?? []) {
                if (legacy.has(id)) githubIds.push(id);
                else if (/^[a-f0-9]{64}$/.test(id)) nativeIds.push(id);
                else throw new BoardError("A selected interaction is outside the accepted report view.", 409);
            }
            if (selection.kind !== "all") selection = { ...selection, scenarioIds: githubIds };
            resolveNativeReportView = services.nativeReportViewResolver({ viewId: input.nativeViewId, nativeIds });
        } else if (services.sourceAware && input.periodComparison?.nativeViewKind !== "current") {
            const ids = input.selection?.scenarioIds ?? input.scenarioIds ?? input.periodComparison?.selection?.scenarioIds;
            const state = await loadBoardState(session), legacy = new Set(mergeEvidenceWithState(state).map(record => record.scenarioId));
            const unenrolledAll = input.selection?.kind === "all" && state.nativeRetention === undefined
                && state.nativeReportPolicy === undefined;
            if (!unenrolledAll && (!Array.isArray(ids) || ids.some(id => !legacy.has(id)))) throw Object.assign(
                new BoardError("Native report selection requires an accepted bounded source view.", 503),
                { code: "native-report-provenance-unqualified" });
        } else if (!services.sourceAware && services.nativeReader) {
            const native = await services.nativeReader.scan();
            const ids = input.selection?.scenarioIds ?? input.scenarioIds ?? input.periodComparison?.selection?.scenarioIds;
            if (ids !== undefined && !Array.isArray(ids)) throw new BoardError("Choose a bounded report selection.", 422);
            if (native.records.length && (!ids || native.records.some(record => ids.includes(record.scenarioId)))) {
                throw Object.assign(new BoardError("Native or mixed report dependencies are not qualified. No report was prepared.", 503),
                    { code: "native-report-provenance-unqualified" });
            }
        }
        const preview = await exports.preview(owner, input.scenarioIds, input.options, selection, input.periodComparison, {
            ...services,
            ...(resolveNativeReportView ? { resolveNativeReportView } : {}),
            semanticSelection: input.semanticSelection,
            resolveSemantic: (receipt, state, layer) => {
                if (!services.search?.membership) throw new BoardError("search-membership-unavailable", 409);
                return services.search.membership(owner, receipt, state, layer);
            },
        });
        return { ...preview, ...(services.sourceAware ? { nativeReportPublication: nativePublicationStatus(services) } : {}) };
    }
    if (action === "confirm_export") {
        validateObject(input, ["previewId", "confirmed", "timeContext"], ["previewId", "confirmed"]);
        const result = await exports.confirm(owner, input.previewId, input.confirmed, input.timeContext, services);
        return { bundle: result.bundle, state: await currentStatePayload(session, undefined, undefined, services.nativeReader, services) };
    }
    throw new BoardError("Unknown action.", 404);
}

function sendJSON(res, status, object) {
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

const startupServers = new WeakMap();

export async function startServer(session, exports, options = {}) {
    if (options.collector?.access !== undefined && options.collector.access !== options.access) {
        throw Object.assign(new BoardError("HTTP collector admission requires the same trusted runtime access binding.", 503),
            { code: "wire_access_writer_integration_pending" });
    }
    if (options.createAccess !== undefined) {
        if (typeof options.createAccess !== "function" || options.access !== undefined || options.startupServer !== undefined) {
            throw new BoardError("Runtime access must have one backend owner.", 503);
        }
        const initializing = (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            sendJSON(res, 503, { error: "Local evidence runtime is initializing." });
        };
        const reserved = createServer(initializing);
        await new Promise((resolve, reject) => {
            reserved.once("error", reject);
            reserved.listen({ port: options.port ?? DEFAULT_RUNTIME_PORT, host: "127.0.0.1", exclusive: true }, resolve);
        });
        startupServers.set(reserved, initializing);
        try {
            const access = await options.createAccess({ origin: `http://127.0.0.1:${reserved.address().port}` });
            if (access === undefined) throw new BoardError("The configured runtime access owner did not start.", 503);
            return await startServer(session, exports, { ...options, createAccess: undefined, access, startupServer: reserved });
        } catch (error) {
            if (reserved.listening) {
                const stopped = new Promise(resolve => reserved.close(resolve));
                reserved.closeAllConnections();
                await stopped;
            }
            throw error;
        } finally { startupServers.delete(reserved); }
    }
    if (options.startupServer !== undefined && !startupServers.has(options.startupServer)) {
        throw new BoardError("The startup endpoint was not reserved by this runtime.", 503);
    }
    const access = options.access;
    const sourcePolicy = options.sourcePolicy ?? (access && !access.copilotOnly ? "microsoft-incubation" : "copilot-only");
    if (!["copilot-only", "microsoft-incubation"].includes(sourcePolicy)
        || sourcePolicy === "copilot-only" && access && !access.copilotOnly) {
        throw new BoardError("The source policy does not match this runtime's access owner.", 503);
    }
    const collectionBound = Boolean(access && (options.collector?.access === access || access.sourceAware === true || access.copilotOnly));
    if (access !== undefined) {
        assertRuntimeAccess(access);
        await access.assertRuntime(session, options);
    }
    const nativeReportPublication = () => {
        const available = access?.sourceAware === true && access.nativeReportPublicationReady?.() === true
            && typeof access.nativeArtifactMutationFor === "function"
            && isReviewedNativeReportController(exports, session);
        return Object.freeze({ schemaVersion: 1, available, reason: available ? null : "runtime-unqualified" });
    };
    const search = createLiveSearch(session, { ...options.search,
        nativeReader: access?.sourceAware ? undefined : access?.nativeReader });
    const recorderDiagnostics = createRecorderDiagnostics(session, options.recorderDiagnostics);
    const deletion = createDeletionController(session, {
        coordinateRecorder: work => recorderDiagnostics.exclusiveActivity(work),
        selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup,
        describeSavedArtifact: createSavedArtifactDescriptor(session),
        ...options.deletion,
        validateBackfillCheckpoint,
        requireAdmission: Boolean(access),
        async onSeal(state, operation) {
            search.invalidate();
            invalidateAssessmentCache();
            if (operation.kind === "artifact-deletion") {
                for (const artifact of operation.artifacts ?? [operation.artifact]) exports.invalidateSavedReport?.(artifact?.artifactId ?? operation.artifactId);
            }
            else { exports.invalidateDerived?.(); exports.discardAll(); }
            if (operation.kind === "activity-deletion") await cleanupDeletedEvaluationWork(session, state);
            await options.deletion?.onSeal?.(state, operation);
        },
    });
    const recollection = createRecollectionController(session, {
        coordinateRecorder: work => recorderDiagnostics.exclusiveActivity(work),
        onCommitted() { search.invalidate(); invalidateAssessmentCache(); exports.invalidateDerived?.(); exports.discardAll(); },
    });
    const services = { deletion, search, nativeReader: access?.nativeReader, nativeCollectionControl: access?.nativeCollectionControl,
        sourceAware: access?.sourceAware === true, copilotOnly: access?.copilotOnly === true,
        manualCollectionAvailable: access?.manualCollectionAvailable, nativeReportPublication };
    const sessions = new Map();
    const githubProfile = createGitHubProfile(session, options.githubProfile);
    const profileRoutes = createGitHubProfileRoutes(githubProfile, {
        ownerActive: owner => [...sessions.values()].some(entry => (entry.owner === owner || entry.privateOwner === owner) && Date.now() - entry.lastUsed < ttlMs),
    });
    const nonce = randomBytes(24).toString("hex");
    const runtimeId = randomUUID();
    const accessBootstrap = Object.freeze({
        schemaVersion: 1, mode: access ? "enforced" : "unbound", runtimeId, ...(access ? ACCESS_TIMING : {}),
        ...(access?.copilotOnly ? { collectionMode: "copilot-only" } : access?.sourceAware ? { collectionMode: "source-aware" } : {}),
    });
    const ttlMs = options.sessionTtlMs ?? 30 * 60 * 1000;
    const releaseAccess = access?.subscribe(() => {
        profileRoutes.close();
        githubProfile.invalidate();
        exports.invalidateDerived?.();
        exports.discardAll();
        invalidateAssessmentCache();
        search.invalidate("wire-access-revoked");
        for (const entry of sessions.values()) entry.privateOwner = null;
    });
    const routes = { ...assessmentRoutes, "/api/period-comparison": "get_period_comparison", "/api/assessment/response-timing/qualify": "qualify_response_timing", "/api/collection/models/qualify": "qualify_interaction_models", "/api/collection/status": "collection_status", "/api/collection/configure": "configure_collection", "/api/collection/enabled": "set_collection_enabled", "/api/collection/now": "collect_now", "/api/analytics": "get_analytics", "/api/snapshot": "get_snapshot", "/api/refresh": "reload_snapshot", "/api/import": "refresh_history", "/api/record": "record_graph_metadata", "/api/move": "move_card", "/api/preview": "preview_export", "/api/export": "confirm_export" };
    let origin;
    let ready = false;
    const watches = new Map();
    const controlError = (code, status) => Object.assign(new BoardError(`WIRE access watch: ${code}.`, status), { code });
    function watch(capability, entry, input, res) {
        if (res.destroyed || res.writableEnded) return;
        validateObject(input, ["schemaVersion", "after"], ["schemaVersion", "after"]);
        if (input.schemaVersion !== 1) throw controlError("wire_access_watch_invalid", 422);
        if (input.after !== null) {
            validateObject(input.after, ["runtimeId", "authorizationRevision"], ["runtimeId", "authorizationRevision"]);
            if (typeof input.after.runtimeId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.after.runtimeId)
                || !Number.isSafeInteger(input.after.authorizationRevision) || input.after.authorizationRevision < 0) {
                throw controlError("wire_access_watch_invalid", 422);
            }
        }
        const current = access.control();
        if (input.after?.runtimeId === runtimeId && input.after.authorizationRevision > current.authorizationRevision) {
            throw controlError("wire_access_watch_future", 409);
        }
        watches.get(capability)?.fail(controlError("wire_access_watch_replaced", 409));
        return new Promise(resolve => {
            let completed = false, timer, unsubscribe;
            const cleanup = () => {
                if (completed) return;
                completed = true;
                clearTimeout(timer); unsubscribe?.();
                if (watches.get(capability) === pending) watches.delete(capability);
                res.off("close", lost);
                resolve();
            };
            function finish(status, body) {
                if (completed) return;
                try {
                    if (!res.destroyed && !res.writableEnded) sendJSON(res, status, body);
                } catch {
                    console.error("[workiq-runtime] access watch delivery failed", { code: "ACCESS_WATCH_DELIVERY_FAILED" });
                    res.destroy();
                } finally { cleanup(); }
            }
            const pending = {
                fail(error) { finish(error.status, { code: error.code, error: error.message }); },
            };
            const lost = () => cleanup();
            function publish(value) {
                if (!ready) return pending.fail(controlError("wire_access_runtime_closed", 503));
                if (sessions.get(capability) !== entry || Date.now() - entry.lastUsed >= ttlMs) {
                    return pending.fail(controlError("session_expired", 403));
                }
                if (!value) return pending.fail(controlError("wire_access_control_unavailable", 503));
                finish(200, { ...accessBootstrap, ...value });
            }
            const observe = value => {
                if (!value || !input.after || input.after.runtimeId !== runtimeId
                    || input.after.authorizationRevision !== value.authorizationRevision) publish(value);
            };
            watches.set(capability, pending);
            res.once("close", lost);
            // Registration and its current-state seed are synchronous; no change can fall between them.
            try {
                const release = access.subscribeControl(observe);
                if (completed) release();
                else {
                    unsubscribe = release;
                    timer = setTimeout(() => {
                        try { publish(access.control()); }
                        catch (error) { pending.fail(error instanceof BoardError ? error : controlError("wire_access_control_unavailable", 503)); }
                    }, Math.max(0, Math.min(ACCESS_TIMING.maxWaitMs, ttlMs - (Date.now() - entry.lastUsed))));
                    timer.unref();
                }
            } catch (error) {
                pending.fail(error instanceof BoardError ? error : controlError("wire_access_control_unavailable", 503));
            }
        });
    }
    function discard(capability) {
        const entry = sessions.get(capability);
        if (entry) {
            watches.get(capability)?.fail(controlError("session_expired", 403));
            access?.releaseOwner(entry.owner);
            const owner = entry.privateOwner ?? entry.owner;
            exports.discard(owner); profileRoutes.release(owner); void search.release(owner, "session-released");
        }
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
    const handleRequest = async (req, res) => {
        let mutation = false;
        let detachAccess, readAccess;
        let mutationDispatched = false;
        let nativeMutation = false;
        let reportSaveRefusal = null;
        let assertRequest = () => {};
        let collectionAdmission = Object.freeze({
            check: () => readAccess ? readAccess.publish(assertRequest) : assertRequest(),
            dispatched: () => { mutationDispatched = true; },
        });
        const commit = work => readAccess ? readAccess.admit(() => {
            assertRequest();
            mutationDispatched = true;
            return work();
        }) : work();
        const requestServices = () => ({
                ...services,
                ...(access?.nativeRetainedFor ? {
                    nativeRetained: access.nativeRetainedFor(readAccess, { check: () => assertRequest() }),
                } : {}),
                ...(access?.nativeReportViewFor ? {
                    nativeReportViewResolver: binding => access.nativeReportViewFor(readAccess, { check: () => assertRequest() }, binding),
                } : {}),
                ...(access?.nativeReportsFor ? access.nativeReportsFor(readAccess, {
                    check: () => assertRequest(),
                    dispatched() {
                        if (!nativeReportPublication().available) throw Object.assign(
                            new BoardError("Native report publication and artifact deletion are not qualified in this runtime. No report was saved.", 503),
                            { code: "NATIVE_REPORT_SAVE_UNAVAILABLE" });
                        mutationDispatched = true;
                    },
                }) : {}),
                nativePersistenceStatus: access?.nativePersistenceStatus
                    ? input => access.nativePersistenceStatus(input, collectionAdmission) : undefined,
                nativeConfigurationOffer: access?.nativeConfigurationOffer
                    ? () => access.nativeConfigurationOffer(collectionAdmission) : undefined,
                globalCollectionControl: access?.globalCollectionControl
                    ? () => access.globalCollectionControl(collectionAdmission) : undefined,
                commitMutation: commit,
                collectionAdmission: collectionBound ? collectionAdmission : undefined,
                coordinateAssessment: work => recorderDiagnostics.exclusiveActivity(() => {
                    const admitted = () => commit(work);
                    return collectorFor(session)?.exclusiveActivity(admitted) ?? admitted();
                }),
            });
        const action = async (owner, name, input) => {
            try { return await executeAction(session, exports, owner, name, input, requestServices()); }
            catch (error) {
                if (name === "confirm_export") reportSaveRefusal = takeNativeSaveRefusal(error, exports, session, owner, input.previewId);
                throw error;
            }
        };
        function finishMutation() { if (mutation) { mutation = false; search.endMutation(); } }
        function send(response, status, object) { finishMutation(); return sendJSON(response, status, object); }
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}' 'self'; worker-src 'self'; style-src 'unsafe-inline'; font-src data:; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'self'`);
        try {
            if (ready && origin && req.method === "GET" && req.url === "/" && req.headers.origin === undefined
                && (!req.headers["sec-fetch-mode"] || req.headers["sec-fetch-mode"] === "navigate")
                && (!req.headers["sec-fetch-dest"] || req.headers["sec-fetch-dest"] === "document")) {
                const alias = new URL(origin);
                alias.hostname = "localhost";
                if (req.headers.host === alias.host) {
                    // Entry spelling only: authority and content are issued at the canonical origin.
                    res.writeHead(302, { Location: `${origin}/`, "Content-Length": "0" });
                    return res.end();
                }
            }
            if (!origin || req.headers.host !== new URL(origin).host) throw new BoardError("Forbidden host.", 403);
            if (req.headers.origin && req.headers.origin !== origin) throw new BoardError("Foreign origin denied.", 403);
            if (!ready) throw new BoardError("Local evidence runtime is initializing.", 503);
            if (req.method === "GET" && req.url === "/health") return send(res, 200, { service: "workiq-evidence", protocol: 1, runtimeId });
            if (req.method === "GET" && Object.hasOwn(browserModules, req.url)) {
                const bytes = await readFile(new URL(browserModules[req.url], import.meta.url));
                res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": bytes.length });
                return res.end(bytes);
            }
            const pdfResource = /^\/assets\/pdf-(fonts|cmaps)\/([A-Za-z0-9_-]+\.(?:pfb|ttf|bcmap))$/.exec(req.url);
            if (req.method === "GET" && pdfResource) {
                const directory = pdfResource[1] === "fonts" ? "standard_fonts" : "cmaps";
                const bytes = await readFile(new URL(`../node_modules/pdfjs-dist/${directory}/${pdfResource[2]}`, import.meta.url));
                res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
                return res.end(bytes);
            }
            if (req.method === "GET" && req.url === "/favicon.svg") {
                res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Length": Buffer.byteLength(logoSvg) });
                return res.end(logoSvg);
            }
            if (req.method === "GET" && req.url === "/") {
                // This entry carries this runtime's own current transport. External
                // transports must qualify compatibility before separate issuance.
                const html = renderHtmlShell(issue(), nonce, accessBootstrap);
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
                if (req.headers["x-wire-session-protocol"] !== "1") {
                    throw Object.assign(new BoardError(
                        "This WIRE client needs an update. Reload the page, or update and reload the WIRE canvas extension. No panel was opened.", 409),
                    { code: "WIRE_CLIENT_UPDATE_REQUIRED" });
                }
                return send(res, 200, { capability: issue(), runtimeId, accessBootstrap });
            }
            prune();
            if (profileRoutes.matchesImage(req.url)) {
                if (access) {
                    readAccess = await access.read("profile-image-route");
                    detachAccess = access.bindResponse(res, readAccess, runtimeId);
                }
                return await profileRoutes.image(req, res);
            }
            const capability = req.headers["x-board-capability"];
            const entry = typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability) ? sessions.get(capability) : undefined;
            if (!entry) return send(res, 403, { code: "session_expired", error: "Local panel connection expired. Reconnect before continuing; actions were not replayed." });
            collectionAdmission = Object.freeze({ ...collectionAdmission, owner: entry.owner });
            if (req.url !== ACCESS_PATHS.watch) entry.lastUsed = Date.now();
            const panelActive = () => sessions.get(capability) === entry && Date.now() - entry.lastUsed < ttlMs;
            function assertPanelActive() {
                if (panelActive()) return;
                const error = new BoardError("Local panel connection expired. No action was replayed.", 403);
                error.code = "session_expired";
                throw error;
            }
            assertRequest = assertPanelActive;
            if (req.url === ACCESS_PATHS.status) {
                if (req.method !== "GET") throw new BoardError("Method not allowed.", 405);
                if (!access) return send(res, 200, accessBootstrap);
                const status = await access.status();
                assertPanelActive();
                if (collectionBound) status.enforcement.acquisition = access.copilotOnly
                    ? "copilot-collector-integrated" : "fixture-collector-integrated";
                return send(res, 200, { ...status, ...accessBootstrap });
            }
            if (req.url === ACCESS_PATHS.watch) {
                if (req.method !== "POST") throw new BoardError("Method not allowed.", 405);
                const input = await readBody(req);
                assertPanelActive();
                if (!access) throw controlError("wire_access_unbound", 503);
                return await watch(capability, entry, input, res);
            }
            if (access && [ACCESS_PATHS.command, ACCESS_PATHS.receipt].includes(req.url)) {
                if (req.method !== "POST") throw new BoardError("Method not allowed.", 405);
                const input = await readBody(req);
                assertPanelActive();
                assertReleasedRequest(sourcePolicy, req.url, input);
                if (req.url === ACCESS_PATHS.command) return send(res, 200, await access.command(entry.owner, input, panelActive));
                const receipt = await access.receipt(entry.owner, input);
                assertPanelActive();
                return send(res, 200, receipt);
            }
            if (req.url === "/api/session/release") {
                if (req.method !== "POST") throw new BoardError("Method not allowed.", 405);
                validateObject(await readBody(req), []);
                discard(capability);
                return send(res, 200, { released: true });
            }
            if (access) {
                readAccess = await access.read(entry.owner);
                if (!panelActive()) {
                    readAccess.release();
                    return send(res, 403, { code: "session_expired", error: "Local panel connection expired. No action was replayed." });
                }
                detachAccess = access.bindResponse(res, readAccess, runtimeId);
                entry.privateOwner = readAccess.owner;
            }
            const owner = readAccess?.owner ?? entry.owner;
            if (req.url === GITHUB_PROFILE_PATH) {
                if (req.method !== "GET") throw new BoardError("Method not allowed.", 405);
                return send(res, 200, await profileRoutes.read(owner));
            }
            if (req.url === "/api/profile/microsoft") {
                if (req.method !== "GET") throw new BoardError("Method not allowed.", 405);
                const presentation = access?.microsoftProfileFor ? await access.microsoftProfileFor(readAccess) : null;
                assertPanelActive();
                return send(res, 200, microsoftProfileView(presentation));
            }
            if (req.method === "GET" && req.url === "/api/state") return send(res, 200,
                await currentStatePayload(session, undefined, undefined, access?.nativeReader, requestServices()));
            if (req.method !== "POST") throw new BoardError("Method not allowed.", 405);
            const input = await readBody(req);
            assertReleasedRequest(sourcePolicy, req.url, input);
            readAccess?.publish(() => {});
            if (["/api/retained/microsoft/query", "/api/retained/microsoft/detail", "/api/retained/microsoft/search",
                "/api/retained/microsoft/analyze", "/api/retained/microsoft/inventory",
                "/api/retained/microsoft/drilldown", "/api/retained/microsoft/readback"].includes(req.url)) {
                const retained = requestServices().nativeRetained;
                if (!retained) throw Object.assign(new BoardError("An admitted Microsoft retained reader is required.", 503),
                    { code: "NATIVE_VIEW_BINDING_REQUIRED" });
                return send(res, 200, await retained[req.url.split("/").at(-1)](input));
            }
            if ((access?.sourceAware || access?.copilotOnly) && req.url === "/api/collection/sources/status") {
                validateObject(input, []);
                return send(res, 200, await sourceAwareCollectionStatus(session, requestServices()));
            }
            if (access?.sourceAware && req.url === "/api/collection/microsoft/enrollment") {
                validateObject(input, []);
                return send(res, 200, await access.nativeEnrollmentStatus(collectionAdmission));
            }
            if (access?.sourceAware && req.url === "/api/collection/microsoft/enroll") {
                nativeMutation = true;
                return send(res, 200, await access.prepareNativeEnrollment(input, collectionAdmission));
            }
            if ((access?.sourceAware || access?.copilotOnly) && req.url === "/api/collection/global/enabled") {
                validateObject(input, ["schemaVersion", "enabled", "generation", "authorizationRevision", "expectedRevision"],
                    ["schemaVersion", "enabled", "generation", "authorizationRevision", "expectedRevision"]);
                nativeMutation = true;
                await access.setGlobalCollectionEnabled(input, collectionAdmission);
                return send(res, 200, await sourceAwareCollectionStatus(session, requestServices()));
            }
            const nativeControlPath = access?.sourceAware ? "/api/collection/microsoft/enabled" : "/api/collection/enabled";
            const nativeControlInput = req.url === nativeControlPath ? input
                : !access?.sourceAware && req.url === "/api/canvas" && input?.action === "set_collection_enabled" ? input.input : undefined;
            if (access?.setNativeCollectionEnabled && nativeControlInput !== undefined) {
                if (req.url === "/api/canvas") validateObject(input, ["action", "input"], ["action", "input"]);
                validateObject(nativeControlInput, ["enabled", "expectedNativeRevision"], ["enabled", "expectedNativeRevision"]);
                nativeMutation = true;
                await access.setNativeCollectionEnabled(nativeControlInput, collectionAdmission);
                const status = access.sourceAware ? await nativeCollectionFields(requestServices())
                    : await action(owner, "collection_status", {});
                collectionAdmission.check();
                return send(res, 200, status);
            }
            const nativeCollectionPrefix = access?.sourceAware ? "/api/collection/microsoft" : "/api/collection";
            const nativeCollectionAction = req.url === `${nativeCollectionPrefix}/configure` ? "configure_collection"
                : req.url === `${nativeCollectionPrefix}/now` ? "collect_now"
                    : req.url === `${nativeCollectionPrefix}/status` ? "collection_status"
                        : !access?.sourceAware && req.url === "/api/canvas"
                            && ["configure_collection", "collect_now", "collection_status"].includes(input?.action) ? input.action : null;
            if (access?.configureNativeCollection && nativeCollectionAction) {
                if (req.url === "/api/canvas") validateObject(input, ["action", "input"], ["action", "input"]);
                const nativeInput = req.url === "/api/canvas" ? input.input : input;
                if (nativeCollectionAction === "collection_status") {
                    if (access.sourceAware) validateObject(nativeInput, Object.hasOwn(nativeInput, "operationId") ? ["operationId"] : []);
                    const status = access.sourceAware ? await nativeCollectionFields(requestServices(), nativeInput)
                        : await action(owner, "collection_status", nativeInput);
                    collectionAdmission.check();
                    return send(res, 200, status);
                }
                if (nativeCollectionAction === "configure_collection") {
                    const fields = access.configureNativeIntent
                        ? ["schemaVersion", "intent", "generation", "authorizationRevision", "expectedRevision", "surfaces", "windowDays",
                            ...(access.sourceAware ? ["globalRevision"] : [])]
                        : ["expectedRevision", "surfaces", "windowDays"];
                    if (access.sourceAware && !access.configureNativeIntent) {
                        throw Object.assign(new BoardError("Source-aware Microsoft configuration is not attached.", 503),
                            { code: "SOURCE_AWARE_NATIVE_CONFIGURATION_UNAVAILABLE" });
                    }
                    validateObject(nativeInput, fields, fields);
                } else validateObject(nativeInput, ["operationId", "expectedBasis", "deadline"]);
                nativeMutation = true;
                const collector = collectorFor(session);
                if (!collector) throw new BoardError("Collection is not attached to this runtime.", 503);
                const collect = () => access.collectNativeNow({
                    operationId: Object.hasOwn(nativeInput, "operationId") ? nativeInput.operationId : randomUUID(),
                    ...(Object.hasOwn(nativeInput, "expectedBasis") ? { expectedBasis: nativeInput.expectedBasis } : {}),
                    ...(Object.hasOwn(nativeInput, "deadline") ? { deadline: nativeInput.deadline } : {}),
                }, collectionAdmission);
                const receipt = nativeCollectionAction === "configure_collection"
                    ? await collector.exclusiveActivity(() =>
                        (access.configureNativeIntent ?? access.configureNativeCollection)(nativeInput, collectionAdmission))
                    : await (access.sourceAware ? collect() : collector.exclusiveActivity(collect));
                const status = access.sourceAware ? await nativeCollectionFields(requestServices())
                    : await action(owner, "collection_status", {});
                collectionAdmission.check();
                if (nativeCollectionAction === "collect_now" && receipt.status !== "committed") {
                    const pending = receipt.status === "pending";
                    return send(res, pending ? 202 : 409, { ...status, nativePersistenceReceipt: receipt,
                        code: pending ? "NATIVE_RETENTION_OPERATION_PENDING" : "NATIVE_RETENTION_OPERATION_UNKNOWN",
                        ...(pending ? {} : { outcome: "unknown", error: "Native collection has no confirmed commit. Read this operation's status; it was not replayed." }) });
                }
                return send(res, 200, { ...status,
                    ...(nativeCollectionAction === "collect_now" ? { nativePersistenceReceipt: receipt } : {}) });
            }
            access?.assertRoute(req.url, input, collectionBound);
            if (req.url === "/api/search/events") {
                if (access?.sourceAware) res.setHeader("X-Wire-Native-Search", "bounded-v1");
                const { nativeReportSource, nativeReportAdmission } = requestServices();
                return search.attach(owner, res, input, nativeReportSource ? { nativeReportSource, nativeReportAdmission } : undefined);
            }
            if (req.url === "/api/search/query") return send(res, 200, search.query(owner, input));
            if (req.url === "/api/search/open") return send(res, 200, await search.open(owner, input));
            if (req.url === "/api/search/status") {
                validateObject(input, []);
                return send(res, 200, search.panelStatus(owner));
            }
            if (req.url === "/api/search/cancel") {
                validateObject(input, []);
                return send(res, 200, search.cancel(owner));
            }
            if (req.url === "/api/search/close") {
                validateObject(input, []);
                await search.release(owner);
                return send(res, 200, { state: "closed" });
            }
            const canvasRead = req.url === "/api/canvas" && typeof input?.action === "string"
                && (input.action.startsWith("get_") || ["collection_status", "reload_snapshot", "preview_export"].includes(input.action));
            if (req.url === "/api/evaluation/status") return send(res, 200, await readEvaluationReceipt(session, owner, input));
            if (req.url === "/api/evaluation/automatic/status") return send(res, 200, await readAutomaticScoreReceipt(session, owner, input));
            if (req.url.startsWith("/api/evaluation/")) rejectAIReview();
            if (req.url === "/api/assessment/feedback" || req.url === "/api/canvas" && input?.action === "set_personal_assessment") rejectPersonalFeedback();
            // Model qualification signals applied changes itself; receipt/no-op reads must not fence Search.
            const modelQualification = req.url === "/api/collection/models/qualify"
                || req.url === "/api/canvas" && input?.action === "qualify_interaction_models";
            if (!searchSafeReads.has(req.url) && !canvasRead && !modelQualification) { mutation = true; search.beginMutation(); }
            if (req.url === "/api/artifact-deletion/eligibility") {
                validateObject(input, ["artifactKind", "artifactId"], ["artifactKind", "artifactId"]);
                if (!["report", "comparison"].includes(input.artifactKind) || typeof input.artifactId !== "string"
                    || !/^export-[a-f0-9-]{36}$/.test(input.artifactId)) throw new BoardError("Choose one saved artifact.", 422);
                if (!access?.nativeArtifactMutationFor) throw Object.assign(
                    new BoardError("Account-qualified artifact eligibility is not attached.", 503),
                    { code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" });
                const guard = await access.nativeArtifactMutationFor(readAccess, {
                    check: () => assertRequest(),
                    dispatched() { throw new BoardError("Artifact eligibility cannot dispatch a mutation.", 403); },
                });
                const artifact = await withNativeArtifactMutation(guard, session, owner, {
                    scope: input, membership: null, readOnly: true,
                }, (state, authorization) => describeSavedArtifact(state.exports.find(entry => entry.bundleId === input.artifactId),
                    state, { authorization, session }));
                readAccess.publish(assertRequest);
                return send(res, 200, { artifact });
            }
            if (req.url === "/api/artifact-deletion/preview") {
                if (input?.scope === "all-reports") validateObject(input, ["scope"], ["scope"]);
                else validateObject(input, ["artifactKind", "artifactId"], ["artifactKind", "artifactId"]);
                if (!deletion.previewArtifact) throw new BoardError("Saved-artifact deletion is not attached.", 503);
                const guard = access?.nativeArtifactMutationFor ? await access.nativeArtifactMutationFor(readAccess, {
                    check: () => assertRequest(),
                    dispatched() { throw new BoardError("An artifact preview cannot dispatch a mutation.", 403); },
                }) : undefined;
                const result = await deletion.previewArtifact(owner, input, guard);
                if (guard) readAccess.publish(assertRequest);
                return send(res, 200, result);
            }
            if (req.url === "/api/artifact-deletion/confirm") {
                validateObject(input, ["operationId", "confirmed"], ["operationId", "confirmed"]);
                if (!deletion.confirmArtifact) throw new BoardError("Saved-artifact deletion is not attached.", 503);
                const guard = access?.nativeArtifactMutationFor ? await access.nativeArtifactMutationFor(readAccess, {
                    check: () => assertRequest(),
                    dispatched: () => { mutationDispatched = true; },
                }) : undefined;
                const result = await deletion.confirmArtifact(owner, input, guard ?? commit);
                if (guard) readAccess.publish(assertRequest);
                return send(res, 200, result);
            }
            if (req.url === "/api/artifact-deletion/status") {
                validateObject(input, ["operationId", "receiptToken"], ["operationId"]);
                if (input.receiptToken !== undefined && (typeof input.receiptToken !== "string" || !/^[a-f0-9]{64}$/.test(input.receiptToken))) throw new BoardError("Invalid artifact receipt capability.", 422);
                return send(res, 200, await deletion.status(input.operationId, owner, input.receiptToken));
            }
            if (req.url === "/api/artifact-deletion/cancel") {
                validateObject(input, ["operationId"], ["operationId"]);
                return send(res, 200, deletion.cancel(owner, input.operationId));
            }
            if (req.url === "/api/report-artifacts/list") {
                validateObject(input, []);
                return send(res, 200, await readReportState(session, requestServices(), null,
                    state => ({ artifacts: state.exports.map(item => describeSavedArtifact(item, state)) })));
            }
            if (req.url === "/api/report-comparison/inspect" || req.url === "/api/report-comparison/preview") {
                const inspect = req.url.endsWith("/inspect");
                validateObject(input, inspect ? ["baselineId", "laterId", "cohort"] : ["baselineId", "laterId", "cohort", "title", "formats", "timeContext", "resultText", "manualTerms"], ["baselineId", "laterId"]);
                const method = inspect ? "inspectComparison" : "previewComparison";
                if (!exports[method]) throw new BoardError("Saved comparison is not attached.", 503);
                const { baselineId, laterId, ...settings } = input;
                return send(res, 200, await exports[method](owner, baselineId, laterId, settings, requestServices()));
            }
            if (req.url === "/api/report-comparison/review") {
                validateObject(input, ["previewId", "disclosureReviewed", "timeContext"], ["previewId", "disclosureReviewed"]);
                return send(res, 200, await exports.reviewComparison(owner, input.previewId, input.disclosureReviewed, input.timeContext, requestServices()));
            }
            if (req.url === "/api/report-comparison/save") {
                validateObject(input, ["previewId", "confirmed", "timeContext"], ["previewId", "confirmed"]);
                const result = await exports.confirmComparison(owner, input.previewId, input.confirmed, input.timeContext, requestServices());
                return send(res, 200, { bundle: result.bundle,
                    state: await currentStatePayload(session, undefined, undefined, access?.nativeReader, requestServices()) });
            }
            if (req.url === "/api/report-comparison/cancel") {
                validateObject(input, ["previewId"], ["previewId"]);
                exports.cancel(owner, input.previewId);
                return send(res, 200, { cancelled: true });
            }
            if (req.url === "/api/report-comparison/open") {
                validateObject(input, ["bundleId"], ["bundleId"]);
                return send(res, 200, await readReportState(session, requestServices(), [input.bundleId],
                    state => openSavedComparison(session, state, input.bundleId)));
            }
            if (req.url === "/api/recollection/sources") {
                validateObject(input, []);
                return send(res, 200, await recollection.sources());
            }
            if (req.url === "/api/recollection/preview") return send(res, 200, await recollection.preview(owner, input));
            if (req.url === "/api/recollection/confirm") return send(res, 200, await recollection.confirm(owner, input));
            if (req.url === "/api/recollection/status") return send(res, 200, await recollection.status(owner, input));
            if (req.url === "/api/recollection/cancel") return send(res, 200, recollection.cancel(owner, input));
            if (req.url === "/api/deletion/preview") {
                const local = access?.localActivityDeletionFor ? await access.localActivityDeletionFor(readAccess, {
                    check: () => assertRequest(),
                    dispatched() { throw new BoardError("A deletion preview cannot dispatch a mutation.", 403); },
                }) : undefined;
                return send(res, 200, await deletion.preview(owner, input, local));
            }
            if (req.url === "/api/deletion/confirm") {
                const local = access?.localActivityDeletionFor ? await access.localActivityDeletionFor(readAccess, {
                    check: () => assertRequest(),
                    dispatched: () => { mutationDispatched = true; },
                }) : undefined;
                const result = await deletion.confirm(owner, input, local ?? commit);
                if (result.phase === "complete") exports.discardAll();
                return send(res, 200, result);
            }
            if (req.url === "/api/deletion/status") {
                validateObject(input, ["operationId"], ["operationId"]);
                return send(res, 200, await deletion.status(input.operationId));
            }
            if (req.url === "/api/deletion/cancel") {
                validateObject(input, ["operationId"], ["operationId"]);
                return send(res, 200, deletion.cancel(owner, input.operationId));
            }
            if (req.url === "/api/record") {
                validateObject(input, ["confirmed", "attemptId"], ["confirmed", "attemptId"]);
                return send(res, 200, await recorderDiagnostics.start(input));
            }
            if (req.url === "/api/record/status") {
                validateObject(input, ["attemptId"]);
                return send(res, 200, await recorderDiagnostics.status(input.attemptId));
            }
            if (req.url === "/api/privacy-review") {
                validateObject(input, ["previewId", "disclosureReviewed", "timeContext"], ["previewId", "disclosureReviewed"]);
                const reviewed = await exports.review(owner, input.previewId, input.disclosureReviewed, input.timeContext, requestServices());
                return send(res, 200, { ...reviewed, ...(access?.sourceAware ? { nativeReportPublication: nativeReportPublication() } : {}) });
            }
            if (req.url === "/api/cancel-preview") {
                validateObject(input, ["previewId"], ["previewId"]);
                exports.cancel(owner, input.previewId);
                return send(res, 200, { cancelled: true });
            }
            if (req.url === "/api/report/open") {
                validateObject(input, ["bundleId"], ["bundleId"]);
                const result = await readReportState(session, requestServices(), [input.bundleId],
                    state => readSavedReportDocument(session, state, input.bundleId));
                return send(res, 200, result);
            }
            if (req.url === "/api/report-original") {
                validateObject(input, ["bundleId", "kind", "format"], ["bundleId", "kind", "format"]);
                const { bytes, binding, ...identity } = await readReportState(session, requestServices(), [input.bundleId], async (state, assertCurrent) => {
                    const original = await readLegacyReportOriginal(session, state, input.bundleId, input.kind, input.format);
                    assertLegacyReportOriginalCurrent(state, original.binding);
                    assertCurrent();
                    return original;
                });
                return send(res, 200, { ...identity, data: bytes.toString("base64"), encoding: "base64" });
            }
            if (req.url === "/api/artifact-file") {
                validateObject(input, ["bundleId", "kind", "format"], ["bundleId", "kind", "format"]);
                const { bytes, ...identity } = await readReportState(session, requestServices(), [input.bundleId],
                    state => readSavedArtifactFile(session, state, input.bundleId, input.kind, input.format));
                return send(res, 200, { ...identity, data: bytes.toString("base64"), encoding: "base64" });
            }
            if (req.url === "/api/report-file") {
                validateObject(input, ["bundleId", "name"], ["bundleId", "name"]);
                const result = await readReportState(session, requestServices(), [input.bundleId], async state => {
                    const bundle = state.exports.find((b) => b.bundleId === input.bundleId);
                    const file = bundle?.files?.[input.name];
                    const root = path.join(resolveDataDir(session), "exports");
                    if (!file || typeof file !== "string" || !path.resolve(file).startsWith(root + path.sep) || path.basename(file) !== input.name) throw new BoardError("Saved report file not found. Previews cannot be downloaded as exports.", 404);
                    const bytes = await readFile(file);
                    return { name: input.name, data: bytes.toString("base64"), encoding: "base64" };
                });
                return send(res, 200, result);
            }
            if (req.url === "/api/canvas") {
                validateObject(input, ["action", "input"], ["action", "input"]);
                return send(res, 200, await action(owner, input.action, input.input));
            }
            if (!routes[req.url]) throw new BoardError("Not found.", 404);
            return send(res, 200, await action(owner, routes[req.url], input));
        } catch (error) {
            const diagnostic = nativeRetentionDiagnostic(error);
            if (readAccess?.signal.aborted || mutationDispatched && error.code === "session_expired") {
                reportSaveRefusal = null;
                if (mutationDispatched) {
                    error = new BoardError("WIRE access changed after this operation began. The local write may have completed. Restore access and check its saved result; do not repeat the operation.", 409);
                    error.code = "wire_access_outcome_unknown";
                } else error = readAccess.signal.reason;
            }
            if (!res.headersSent) detachAccess?.();
            error = assessmentError(error);
            const outcomeUnknown = !reportSaveRefusal && mutationDispatched && (nativeMutation || ["wire_access_outcome_unknown", "wire_access_admission_failed",
                "collection_configuration_outcome_unknown"].includes(error.code) || !(error instanceof BoardError) || error.status >= 500);
            if (diagnostic) console.error("[workiq-runtime] operation failed", {
                code: diagnostic.code, stage: diagnostic.stage, scanDomain: diagnostic.scanDomain,
                credentialCategory: diagnostic.credentialCategory,
            });
            else if (!(error instanceof BoardError)) console.error("[workiq-runtime] operation failed", { code: "INTERNAL" });
            if (!res.headersSent && !res.destroyed) send(res, error instanceof BoardError ? error.status : 500, {
                ...(error.code ? { code: error.code } : {}),
                ...(outcomeUnknown ? { outcome: "unknown" } : {}),
                ...(reportSaveRefusal ? { reportSave: reportSaveRefusal } : {}),
                error: error instanceof BoardError ? error.message : "Local board operation failed. No success was recorded; read state before retrying.",
            });
        } finally { finishMutation(); }
    };
    const server = options.startupServer ?? createServer();
    const initializing = startupServers.get(server);
    if (initializing) server.removeListener("request", initializing);
    server.on("request", handleRequest);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    if (!server.listening) {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen({ port: options.port ?? DEFAULT_RUNTIME_PORT, host: "127.0.0.1", exclusive: true }, resolve);
        }).catch(error => { releaseAccess?.(); throw error; });
    }
    origin = `http://127.0.0.1:${server.address().port}`;
    let collector;
    try {
        // Acquire the fixed listening endpoint before any state initialization/writes.
        collector = await createCollector(session, {
            ...options.collector,
            ...(collectionBound ? { access } : {}),
            requireRequestAdmission: collectionBound,
            onCommitted: async (check, change) => {
                if (change?.stateChanged !== false) search.invalidate("collected");
                await options.collector?.onCommitted?.(check, change);
            },
        });
        await deletion.recover();
        await loadBoardState(session);
        access?.startNativeCollection?.(work => collector.exclusiveActivity(work), () => {
            search.invalidate("collected"); invalidateAssessmentCache();
        });
        ready = true;
    } catch (error) {
        releaseAccess?.();
        await githubProfile.close();
        await search.close();
        if (collector) await collector.close();
        await new Promise(resolve => server.close(resolve));
        throw error;
    }
    const closeServer = server.close;
    const pruneTimer = setInterval(prune, Math.min(ttlMs, 10000));
    pruneTimer.unref();
    server.close = function (callback) {
        ready = false;
        for (const pending of watches.values()) pending.fail(controlError("wire_access_runtime_closed", 503));
        releaseAccess?.();
        for (const entry of sessions.values()) access?.releaseOwner(entry.owner);
        clearInterval(pruneTimer);
        profileRoutes.close();
        Promise.all([access?.stopNativeCollection?.(), search.close(), githubProfile.close()]).then(() => closeServer.call(server, error => {
            Promise.all([collector.close(), recorderDiagnostics.close()])
                .then(() => callback?.(error), failure => callback?.(failure));
        }), failure => callback?.(failure));
        return server;
    };
    server.on("close", () => { for (const capability of sessions.keys()) discard(capability); });
    return {
        server, collector, search, githubProfile, recorderDiagnostics, url: `${origin}/`, runtimeId, accessBootstrap,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}
