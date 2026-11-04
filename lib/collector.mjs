import { copyFile, mkdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { AsyncResource } from "node:async_hooks";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BoardError, loadBoardState, replaceEvidence, resolveDataDir, updateBoardState, stageEvidenceSnapshot, exclusiveBoard } from "./store.mjs";
import { detectSource, discoverSources, validateStoredSourcePaths } from "./source-discovery.mjs";
import { bindSourceHost, shareSourceHost, sourceHost } from "./source-host.mjs";
import { sourceMetadataStamp } from "./source-reader.mjs";
import { acquireCollectorLock, assertCollectorLockOwned, atomicJson, hash, readJson, readTail, tailReadBudget, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { emptyCollectorIndex, validateCollectorIndex, withCollectorIndexBarrier, installCollectorIndexBarrier } from "./collector-index.mjs";
import { recoverSameReadCompletions, isIncompleteWorkIqCall } from "./completion-recovery.mjs";
import { selectBackfillWork, readBackfillChunk, stageBackfillProgress, stageBackfillReset, backfillProgressSummary } from "./collector-backfill.mjs";
import { loadBackfillCheckpoint, publishBackfillCheckpoint } from "./collector-backfill-store.mjs";
import { extractScenarios, completionResultMetadata, completionResultEvidence, completeWorkIqCall, failureMetadata } from "./history.mjs";
import { extractGraphActivities, isHistoryTool, completeGraphActivity } from "./graph-history.mjs";
import { completionMetadata } from "./graph-history-io.mjs";
import { textFindings } from "./privacy.mjs";
import { createCollectionStatus } from "./collection-status.mjs";
import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { filterDeletedRecords, filterDeletedEvents, activityDeletionVersion } from "./deletion-identities.mjs";
import { assessmentSource, invalidateAssessmentCache } from "./assessment-read-model.mjs";
import { collectRecordedAnswerCandidates, commitRecordedAnswers } from "./assessment-capture.mjs";
import { promptAuthorship, promptCapture, promptRecord, mergePromptMetadata, automaticPromptQualificationVersion } from "./prompt-authorship.mjs";
import { historyGap, isHistoryGap, retainedToolRequestIds, alignPromptUpdates, canLinkMissingPrompt } from "./prompt-linkage.mjs";
import { qualifyRetainedKickoff, qualifyRetainedPromptEvents, PROMPT_LOOKUP_VERSION } from "./prompt-qualification.mjs";
import { retainResponseTimingEvent, recordedResponseTiming } from "./response-timing.mjs";
import { qualifyRetainedResponseTimings, qualifyRetainedInteractionModels } from "./response-timing-qualification.mjs";
import { retainInteractionModelMetadata, recordedInteractionModels, mergeInteractionModelEvidence, interactionModelFact, restoreRetainedInteractionModelMetadata } from "./interaction-model.mjs";
import { assertRuntimeAccess } from "./runtime-access.mjs";

const credential = value => textFindings(typeof value === "string" ? value : JSON.stringify(value)).some(f => f.mandatory);
const historyStatus = createCollectionStatus();
const dateNow = () => new Date().toISOString();
const checkpointIdentity = index => JSON.stringify(Object.entries(index.sources).map(([id, row]) => {
    const { lastCheckedAt, lastAttemptAt, ...durable } = row;
    return [id, durable];
}));
const controllers = new Map();
export const collectorFor = session => controllers.get(resolveDataDir(session));
export function collectionSummary(status) {
    const { cursors, historyIssues, ...summary } = status;
    return { ...summary, lastCheck: status.lastCheck ? {
        ...status.lastCheck, changes: { added: status.lastCheck.changes.added, updated: status.lastCheck.changes.updated },
    } : null, discovery: status.discovery ? {
        ...status.discovery, roster: undefined, unmappedWorkspaces: undefined,
    } : null };
}

export function retainEvent(event, counts, promptContext) {
    if (isHistoryGap(event)) return historyGap(event.id, event.data.reason, event.data.offset);
    const { id, type, timestamp } = event ?? {}, data = event?.data ?? {};
    if (typeof id !== "string" || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return null;
    if (type === "tool.execution_complete") {
        const graph = completionMetadata(event);
        const results = completionResultMetadata(data).map(r => ({
            statusCode: r.statusCode, error: r.errorCode ? { code: r.errorCode } : null,
            ...(r.errorDiagnostic ? { wireErrorDiagnostic: r.errorDiagnostic } : {}),
            ...(r.paginationPresent ? { body: { "@odata.nextLink": "[present; URL excluded]" } } : {}),
        }));
        return { id, type, timestamp, ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}), data: { ...graph.data, model: data.model,
            wireFailureEvidence: failureMetadata(data), wireResultEvidence: completionResultEvidence(data), result: {
            content: credential(graph.data.result.content) ? "" : graph.data.result.content,
            structuredContent: { ...graph.data.result.structuredContent, results },
        } } };
    }
    if (type === "user.message") {
        const wirePromptAuthorship = promptAuthorship.fromEvent(event, promptContext);
        const wirePromptAuthorshipVersion = promptAuthorship.version;
        if (typeof data.content !== "string" || credential(data.content)) {
            if (typeof data.content !== "string") counts.unsupportedPromptContents = (counts.unsupportedPromptContents ?? 0) + 1;
            else counts.credentialExclusions++;
            return { id, type, timestamp, data: { content: null, wirePromptAuthorship, wirePromptAuthorshipVersion,
                wirePromptCapture: promptCapture(event, typeof data.content !== "string" ? "unsupported-content" : "credential-excluded"),
                ...(typeof data.messageId === "string" ? { messageId: data.messageId } : {}) } };
        }
        return { id, type, timestamp, data: { content: data.content, wirePromptAuthorship, wirePromptAuthorshipVersion,
            wirePromptCapture: promptCapture(event),
            ...(typeof data.messageId === "string" ? { messageId: data.messageId } : {}) } };
    }
    if (type === "assistant.message") {
        const timing = retainResponseTimingEvent(event);
        const fallback = typeof data.content === "string" && /fallback|falling back|instead|switch/i.test(data.content) && !credential(data.content);
        return timing ? { ...timing, data: { ...timing.data, wireOriginalModel: retainInteractionModelMetadata(event),
            wireToolRequestIds: retainedToolRequestIds(event),
            ...(fallback ? { content: data.content } : {}) } } : null;
    }
    if (type === "assistant.turn_start" || type === "assistant.turn_end") return retainResponseTimingEvent(event);
    if (type !== "tool.execution_start" && type !== "subagent.started") return null;
    if (type === "tool.execution_start" && !isHistoryTool(data)) return null;
    if (credential(data.arguments ?? {})) { counts.credentialExclusions++; return null; }
    return { id, type, timestamp, ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}), data: {
        toolCallId: data.toolCallId, toolName: data.toolName, mcpToolName: data.mcpToolName,
        mcpServerName: data.mcpServerName, mcpConfigServerName: data.mcpConfigServerName,
        arguments: data.arguments, parentToolCallId: data.parentToolCallId, model: data.model,
        wireParentInvocation: data.parentToolCallId == null ? "source-field-absent" : "recorded",
        turnId: data.turnId, mcpTransport: data.mcpTransport,
    } };
}

function completionUpdate(previous, incoming, key) {
    if (!previous) return incoming;
    const excluded = code => {
        console.warn("[workiq-collector] completion excluded", { code });
        return previous;
    };
    if (previous.completionEventId && !incoming.completionEventId) return previous;
    if (!incoming.completionEventId) return incoming;
    if (key === "toolCallId") {
        if (!previous.completionEventId) return isIncompleteWorkIqCall(previous) ? incoming : excluded("COMPLETION_TARGET_UNQUALIFIED");
        const { order: previousOrder, ...oldFacts } = previous;
        const { order: incomingOrder, ...newFacts } = incoming;
        return isDeepStrictEqual(oldFacts, newFacts) ? previous : excluded("COMPLETION_ALREADY_RECORDED");
    } else if (["activityId", "sourceSessionId", "startEventId", "startedAt", "toolCallId", "endpoint", "method"]
        .some(name => !isDeepStrictEqual(previous[name], incoming[name]))
        || previous.completionEventId && previous.completionEventId !== incoming.completionEventId
        || previous.httpStatus != null && previous.httpStatus !== incoming.httpStatus
        || previous.evidenceLevel === "output-visible-http" && incoming.evidenceLevel !== previous.evidenceLevel
        || (previous.evidenceRefs ?? []).some(ref => !(incoming.evidenceRefs ?? []).some(next => isDeepStrictEqual(ref, next)))) {
        return excluded("COMPLETION_FACT_CONFLICT");
    }
    return incoming;
}

export function mergedRecords(current, updates) {
    const groups = new Map(current.map(s => [s.scenarioId, s]));
    function mergeItems(old = [], added = [], key) {
        const items = new Map(old.map(item => [item[key], item]));
        for (const item of added) {
            const previous = items.get(item[key]);
            items.set(item[key], completionUpdate(previous, item, key));
        }
        return [...items.values()].map((item, index) => key === "toolCallId" ? { ...item, order: index + 1 } : item);
    }
    for (const next of updates) {
        const prior = groups.get(next.scenarioId);
        if (!prior) { groups.set(next.scenarioId, next); continue; }
        if (prior.sourceSessionId !== next.sourceSessionId) continue;
        if (JSON.stringify(prior) === JSON.stringify(next)) continue;
        const incomingChanged = key => Object.hasOwn(next, key) && !isDeepStrictEqual(prior[key], next[key]);
        const linkMissing = canLinkMissingPrompt(prior, next);
        const { promptAssociationEvidence, ...incoming } = next;
        groups.set(next.scenarioId, {
            ...incoming, ...prior,
            ...(linkMissing ? { userPrompt: next.userPrompt, promptAssociationEvidence } : {}),
            ...(next.originalModelEvidence && incomingChanged("originalModelEvidence")
                ? { originalModelEvidence: mergeInteractionModelEvidence(prior.originalModelEvidence, next.originalModelEvidence) } : {}),
            ...(next.responseTiming && (next.responseTiming.status === "measured" || prior.responseTiming?.status !== "measured"
                || ["later-work-after-final-response", "deleted-timing-dependency", "conflicting-timing-events", "invalid-response-timing"].includes(next.responseTiming.reason))
                ? { responseTiming: next.responseTiming } : {}),
            ...(next.userPrompt?.authorship && prior.sourceSessionId === next.sourceSessionId
                && prior.userPrompt?.sourceEventId === next.userPrompt?.sourceEventId
                ? { userPrompt: mergePromptMetadata(prior.userPrompt, next.userPrompt) } : {}),
            ...(incomingChanged("toolCalls") ? { toolCalls: mergeItems(prior.toolCalls, next.toolCalls, "toolCallId") } : {}),
            ...(incomingChanged("graphActivities") ? { graphActivities: mergeItems(prior.graphActivities, next.graphActivities, "activityId") } : {}),
            ...(incomingChanged("followUpPrompts") ? { followUpPrompts: prior.followUpPrompts?.length ? prior.followUpPrompts.map(prompt => {
                const update = prior.sourceSessionId === next.sourceSessionId && next.followUpPrompts?.find(value =>
                    value.sourceEventId === prompt.sourceEventId);
                return update?.authorship ? mergePromptMetadata(prompt, update) : prompt;
            }) : next.followUpPrompts } : {}),
        });
    }
    return [...groups.values()];
}

function evidenceChanges(before, after) {
    const content = row => {
        const { scenarioId, scenarioIds, scope, archiveVerified, projectId, ...evidence } = row;
        return evidence;
    };
    const entries = records => {
        const rows = layer => buildActivityAnalytics(records, { layer, bucket: "month", filters: { scope: "all", includeMetadata: true } }).rows;
        const reported = new Map();
        for (const row of rows("reported-api")) {
            if (!reported.has(row.parentCallId)) reported.set(row.parentCallId, []);
            reported.get(row.parentCallId).push(content(row));
        }
        return new Map([
            ...rows("tool").map(row => ({ row, kind: "tool", results: reported.get(row.id) ?? [] })),
            ...[...rows("direct-request"), ...rows("code-reference")].map(row => ({ row, kind: "graph" })),
        ].map(({ row, kind, results }) => [row.id, {
            kind, rowId: row.id, id: kind === "tool" ? row.toolCallId ?? row.id : row.activityId, sourceSessionId: row.sourceSessionId,
            fingerprint: JSON.stringify([content(row), results]),
        }]));
    };
    const previous = entries(before), items = [];
    for (const [rowId, item] of entries(after)) {
        const prior = previous.get(rowId);
        if (prior?.fingerprint === item.fingerprint) continue;
        const { fingerprint, ...identity } = item;
        items.push({ ...identity, change: prior ? "updated" : "added" });
    }
    return { added: items.filter(item => item.change === "added").length, updated: items.filter(item => item.change === "updated").length, items };
}

function contextAfter(events, diagnostics) {
    const completions = new Set(events.filter(e => e.type === "tool.execution_complete").map(e => e.data.toolCallId));
    const starts = new Set(events.filter(e => e.type === "tool.execution_start").map(e => e.data.toolCallId));
    const useful = events.filter(e => e.type !== "tool.execution_complete"
        || !Number.isNaN(e.data.toolCallId) && starts.has(e.data.toolCallId));
    // Keep recent context, full script snapshots and unresolved calls. Evictions are disclosed, never reconstructed.
    const wanted = new Set(useful.slice(-300).map(e => e.id));
    let prompt;
    for (const e of useful) {
        if (isHistoryGap(e)) { prompt = e; wanted.add(e.id); }
        if (e.type === "user.message") prompt = e;
        if (e.type === "tool.execution_start" && (!completions.has(e.data.toolCallId) || /\*\*\* Add File:/.test(JSON.stringify(e.data.arguments)))) {
            wanted.add(e.id);
            if (prompt) wanted.add(prompt.id);
        }
        if (prompt) wanted.add(prompt.id);
    }
    let retained = useful.filter(e => wanted.has(e.id));
    let pending = retained.findLast(event => event.type === "user.message" || isHistoryGap(event));
    if (pending && Buffer.byteLength(JSON.stringify(pending)) > TAIL_LIMITS.maxPendingPromptBytes) {
        const gap = historyGap(`wire-gap-${hash(pending.id)}`, "context-evicted");
        retained = retained.map(event => event === pending ? gap : event);
        pending = gap;
        diagnostics.contextEvictions++;
    }
    const exempt = isHistoryGap(pending) || pending?.data?.wirePromptCapture?.version === 1 ? pending : undefined;
    let remaining = retained.length, generalCount = 0, generalBytes = 2;
    // Size the general JSON array once, including its brackets and commas; only qualified pending originals have a separate allowance.
    const sizes = retained.map(event => {
        if (event === exempt) return 0;
        const size = Buffer.byteLength(JSON.stringify(event));
        generalBytes += size + (generalCount++ > 0 ? 1 : 0);
        return size;
    });
    const result = [];
    for (let i = 0; i < retained.length; i++) {
        const event = retained[i];
        if ((remaining > TAIL_LIMITS.maxContextEvents || generalBytes > TAIL_LIMITS.maxContextBytes) && event !== pending) {
            remaining--;
            if (event !== exempt) {
                generalBytes -= sizes[i] + (generalCount > 1 ? 1 : 0);
                generalCount--;
            }
            diagnostics.contextEvictions++;
        } else result.push(event);
    }
    if (remaining > TAIL_LIMITS.maxContextEvents || generalBytes > TAIL_LIMITS.maxContextBytes) {
        throw new BoardError("Pending prompt metadata exceeds the bounded context budget.", 422);
    }
    return result;
}

export function collectionCoverage(discovery, rows, records, since, until) {
    const eligible = new Set(discovery.roster.filter(r => r.eligible).map(r => r.sessionId));
    const active = records.filter(s => !s.isLegacy && eligible.has(s.sourceSessionId));
    const calls = active.flatMap(s => s.toolCalls ?? []).filter(c => c.tool?.startsWith("workiq-") && c.startedAt >= since);
    const included = new Set(active.filter(s => s.toolCalls?.some(c => c.startedAt >= since)).map(s => s.sourceSessionId));
    const graph = active.flatMap(s => s.graphActivities ?? []);
    const roster = discovery.roster.map(source => ({ ...source, ...rows[source.sessionId],
        disposition: !source.eligible ? source.disposition : rows[source.sessionId]?.error ? "history-read-failed"
            : !rows[source.sessionId]?.scanned ? "awaiting-history-read" : included.has(source.sessionId) ? "included" : "no-qualifying-calls-in-window",
    }));
    return {
        schemaVersion: 2, discoveryMethod: discovery.adapter, checkedAt: discovery.checkedAt, since, until,
        counts: { listed: discovery.counts.sessions, eligible: eligible.size, scanned: roster.filter(r => r.scanned).length,
            includedSessions: included.size, includedProjects: new Set(active.filter(s => included.has(s.sourceSessionId)).map(s => s.projectId).filter(Boolean)).size,
            includedCalls: calls.length, includedScenarios: active.filter(s => included.has(s.sourceSessionId)).length,
            failed: roster.filter(r => r.eligible && r.error).length, excluded: roster.filter(r => !r.eligible).length },
        roster,
        dynamic: { adapter: discovery.adapter, counts: discovery.counts, limits: { ...discovery.limits, ...TAIL_LIMITS } },
        graphHistory: { since, until, scannedAt: until, limits: TAIL_LIMITS, exclusions: {},
            coverage: { sourcesRequested: eligible.size, sourcesScanned: roster.filter(r => r.scanned).length,
                graphActivities: graph.length, requestedDirectSites: graph.filter(a => !a.synthetic && a.evidenceLevel !== "code-reference").length,
                outputVisibleStatuses: graph.filter(a => !a.synthetic && a.evidenceLevel === "output-visible-http").length,
                codeReferences: graph.filter(a => !a.synthetic && a.evidenceLevel === "code-reference").length,
                syntheticReferences: graph.filter(a => a.synthetic).length } },
    };
}

export async function createCollector(session, { timers = true, onCommitted = () => {}, access, requireRequestAdmission = false } = {}) {
    if (typeof onCommitted !== "function") throw new TypeError("A collection observer must be a function.");
    if (access !== undefined) assertRuntimeAccess(access);
    if (requireRequestAdmission && !access) throw new TypeError("Request admission requires a trusted runtime access binding.");
    const dir = resolveDataDir(session);
    if (controllers.has(dir)) throw new BoardError("A collector already owns this store in this process.", 409);
    const release = await acquireCollectorLock(dir);
    const root = path.join(dir, "collector");
    let config, index, timer, running, closing, closed = false, discovery, connected = false, discoveryAt = 0, rotation = 0;
    let authorizationReady = !access;
    let indexVersionFloor = 1;
    let acquisitionEpoch = 0;
    let releaseAuthorization;
    let lastError = null, changing = false, settings = Promise.resolve(), manualCheck, manualCheckBasis, lastCheck, lastCheckWarning = null;
    let responseTimingJob = null;
    let modelQualification = null;
    const modelStatus = value => value ? {
        operationId: value.operationId, phase: value.phase, requested: value.requested,
        applied: value.applied, results: value.results, bytesRead: value.bytesRead, error: value.error ?? null,
    } : null;
    const responseTimingCheckpoints = new Map();
    const timingStatus = () => responseTimingJob ? {
        operationId: responseTimingJob.operationId, phase: responseTimingJob.phase,
        requested: responseTimingJob.scenarioIds.length, results: responseTimingJob.results,
        error: responseTimingJob.error ?? null,
    } : null;
    const timingIdentity = records => hash(JSON.stringify(records.map(record => [
        record.scenarioId, record.sourceSessionId, record.userPrompt?.sourceEventId, record.userPrompt?.sourceTimestamp,
        record.assessmentMembershipPruned === true, (record.toolCalls ?? []).map(call => [call.toolCallId, call.startEventId]),
    ]).sort((a, b) => a[0].localeCompare(b[0]))));
    try {
        config = await readJson(path.join(root, "config.json"));
        lastCheck = await readJson(path.join(root, "last-check.json"));
        if (lastCheck && lastCheck.schemaVersion !== 2) {
            if (Number.isSafeInteger(lastCheck.revision) && lastCheck.beforeRevision === lastCheck.revision) {
                lastCheck = { ...lastCheck, schemaVersion: 2, changes: { added: 0, updated: 0, items: [] },
                    correction: "Earlier raw-alias novelty counts were not canonical. An unchanged committed revision proves this check persisted no evidence changes." };
            } else {
                lastCheck = null;
                lastCheckWarning = "An earlier manual check has noncanonical novelty counts and cannot be reused. Check the approved source again for a confirmed result.";
            }
        }
        index = validateCollectorIndex(await readJson(path.join(root, "index.json"), emptyCollectorIndex()));
        indexVersionFloor = index.schemaVersion;
        if (config && (config.schemaVersion !== 1 || config.approved !== true)) throw new Error("Invalid collector approval configuration.");
        await bindSourceHost(session, config);
        if (access) { await access.initializeCollection(session, config); authorizationReady = true; }
    } catch (error) { await release(); throw error; }

    // Notifications may arm a timer under the lifecycle guard; only its deferred run changes context.
    const timerScope = access && timers ? new AsyncResource("WIRECollectorTimer", { requireManualDestroy: true }) : null;
    const runScheduled = () => { run(false).catch(() => {}); };
    const timerCallback = timerScope ? timerScope.bind(runScheduled) : runScheduled;
    function schedule() {
        clearTimeout(timer);
        if (!timers || closed || changing || !config?.enabled || !authorizationReady || access && !access.collectionAvailable()) return;
        timer = setTimeout(timerCallback, config.pollSeconds * 1000);
        timer.unref();
    }
    function changeSetting(work) {
        const next = settings.then(async () => {
            changing = true; clearTimeout(timer);
            try { return await work(); }
            finally { changing = false; schedule(); }
        });
        settings = next.catch(() => {});
        return next;
    }
    function checkConfigVersion(expected) {
        if (expected !== undefined && expected !== (config ? hash(JSON.stringify(config)) : null)) {
            throw new BoardError("Collection settings changed in another panel. Read the current connection before saving; no settings were replaced.", 409);
        }
    }
    async function waitForRun() {
        try { if (running) await running; }
        catch (error) {
            const code = error.code === "wire_access_admission_failed" ? error.cause?.code : error.code;
            if (!access || !["collection_acquisition_superseded", "wire_access_revoked"].includes(code)) throw error;
        }
    }
    function validateConfiguration(input) {
        if (!input || input.approved !== true || ![5, 15, 30, 60].includes(input.pollSeconds)
            || ![7, 30, 90].includes(input.windowDays) || typeof input.enabled !== "boolean"
            || Object.keys(input).some(k => !["appDbPath", "sessionRoot", "approved", "enabled", "windowDays", "pollSeconds", "expectedConfigVersion"].includes(k))) {
            throw new BoardError("Approve a local source, choose 7/30/90 days and a 5/15/30/60-second cadence.", 422);
        }
        validateStoredSourcePaths(input);
    }
    function configurationOutcomeUnknown() {
        return Object.assign(new BoardError("Collection settings were saved but follow-up synchronization or acquisition failed. Read current settings before another change; nothing was replayed.", 409),
            { code: "collection_configuration_outcome_unknown" });
    }
    function requestAdmission(value) {
        if (value === undefined && !requireRequestAdmission) return null;
        if (!value || typeof value.check !== "function" || typeof value.dispatched !== "function") {
            throw Object.assign(new BoardError("Backend collection request admission is required.", 503),
                { code: "mutation_admission_required" });
        }
        return value;
    }
    const stateIdentity = state => hash(JSON.stringify([
        state, state.evidence ?? [], state.importCoverage ?? null, assessmentSource(state, config),
    ]));
    function assertExpectedBasis(expected) {
        if (expected && (expected.configVersion !== (config ? hash(JSON.stringify(config)) : null)
            || expected.generation !== access?.control().generation)) {
            throw Object.assign(new BoardError("The captured GitHub collection settings changed. No source check was started.", 409),
                { code: "COLLECTION_EXPECTED_BASIS_CHANGED" });
        }
    }
    async function run(reconcile, manual = false, request, expected) {
        if (closed) throw new BoardError("Collection runtime is stopped.", 409);
        if (!config?.approved) throw new BoardError("Connect and approve a local Copilot source first.", 428);
        if (!authorizationReady) throw new BoardError("Committed collection settings need authorization synchronization. Restart before acquiring more source data.", 503);
        assertExpectedBasis(expected);
        if (running) { await running; return api.status(); }
        let stateChanged = true;
        running = (async () => {
            const start = Date.now();
            const checkId = randomUUID(), configVersion = hash(JSON.stringify(config));
            const acquiredEpoch = acquisitionEpoch;
            function assertAcquisitionCurrent() {
                request?.check();
                if (access && (closed || acquiredEpoch !== acquisitionEpoch || configVersion !== hash(JSON.stringify(config)))) {
                    throw Object.assign(new BoardError("Collection was superseded by a settings or shutdown request. No stale cycle was admitted.", 409),
                        { code: "collection_acquisition_superseded" });
                }
            }
            const previousIndex = structuredClone(index);
            let publicationStarted = false, publicationOwnerHost;
            try {
                const acquisition = await access?.acquireCollectionLease(manual ? request : undefined);
                assertAcquisitionCurrent();
                assertExpectedBasis(expected);
                const files = sourceHost(config);
                files.assertCurrent();
                if (reconcile || !discovery || Date.now() - discoveryAt >= 30000) {
                    discovery = await discoverSources(config);
                    assertAcquisitionCurrent();
                    discoveryAt = Date.now();
                }
                connected = true;
                const state = await loadBoardState(session);
                const beforeIdentity = stateIdentity(state);
                const answerCandidates = [];
                const captureAnswers = state.personalEvaluation?.consent?.state === "enabled"
                    && state.personalEvaluation.consent.categories.includes("answer")
                    && state.personalEvaluation.consent.sourceConfigRef === assessmentSource(state, config).sourceConfigRef;
                let records = state.evidence ?? [];
                const initialRecords = JSON.stringify(records);
                const since = new Date(Date.now() - config.windowDays * 86400000).toISOString();
                const until = dateNow();
                const publicationSources = new Map();
                const sourceMembership = source => JSON.stringify([source.sessionId, source.appId, source.eligible,
                    source.workspaceIds ?? [], source.activeWorkspaceIds ?? [], source.projectId, source.projectType,
                    source.archiveEvidence ?? null, source.promptCreation ?? null]);
                const metadataStamp = () => sourceMetadataStamp(files);
                let checkedMetadataStamp = discovery.metadataStamp;
                const changedSource = () => Object.assign(new BoardError("Source or collection membership changed before publication. Read current state before another check.", 409),
                    { code: "COLLECTION_SOURCE_CHANGED" });
                const assertPublicationCurrent = () => {
                    assertAcquisitionCurrent();
                    files.assertCurrent();
                    if (!publicationSources.size) return;
                    for (const frame of publicationSources.values()) {
                        if (sourceFileStamp(statSync(files.historyFile(frame.sourceId))) !== frame.stamp) throw changedSource();
                    }
                    const currentStamp = metadataStamp();
                    if (currentStamp !== checkedMetadataStamp) throw changedSource();
                    assertAcquisitionCurrent();
                };
                const revalidateMetadata = async () => {
                    assertAcquisitionCurrent();
                    files.assertCurrent();
                    if (publicationSources.size && metadataStamp() !== checkedMetadataStamp) {
                        const latest = await discoverSources(config);
                        assertAcquisitionCurrent();
                        const current = new Map(latest.roster.map(source => [source.sessionId, source]));
                        for (const [id, frame] of publicationSources) {
                            if (!current.get(id) || sourceMembership(current.get(id)) !== frame.membership) throw changedSource();
                        }
                        checkedMetadataStamp = latest.metadataStamp;
                    }
                    assertPublicationCurrent();
                };
                const bindPublicationSource = (source, file, stamp) =>
                    publicationSources.set(source.sessionId, { file, sourceId: source.sessionId, stamp, membership: sourceMembership(source) });
                let backfillPrevious = null, backfillNext = null, backfillState = null, backfillProblem = null;
                const fingerprint = hash(JSON.stringify([config.appDbPath, config.sessionRoot, config.windowDays]));
                if (index.fingerprint !== fingerprint) { index.sources = {}; index.promptOrigins = []; index.fingerprint = fingerprint; }
                const promptHash = text => createHmac("sha256", state.pseudonymKey).update(text).digest("hex");
                const origins = new Map((index.promptOrigins ?? []).map(origin => [origin.eventId, origin]));
                const eligible = discovery.roster.filter(r => r.eligible);
                const ordered = [...eligible.slice(rotation), ...eligible.slice(0, rotation)];
                let bytes = 0, checked = 0;
                const pending = [];
                for (const source of ordered) {
                    if (access) { await access.assertCollectionLease(acquisition); assertAcquisitionCurrent(); }
                    if (closed || bytes >= TAIL_LIMITS.cycleBytes) break;
                    const id = source.sessionId;
                    let file;
                    const checkpointPath = path.join(root, fingerprint, `${id}.json`);
                    try {
                        file = files.historyFile(id);
                        const info = await stat(file);
                        const stamp = [info.size, info.mtimeMs, info.ctimeMs, info.ino, info.birthtimeMs].join(":");
                        if (index.sources[id]?.fileStamp === stamp && index.sources[id].cursor?.backlogBytes === index.sources[id].cursor?.partialBytes && !index.sources[id].error) {
                            index.sources[id].lastCheckedAt = until;
                            index.sources[id].lastAttemptAt = until;
                            checked++;
                            continue;
                        }
                        const saved = await readJson(checkpointPath);
                        const old = saved?.cursor;
                        const budget = tailReadBudget(old, TAIL_LIMITS.cycleBytes - bytes);
                        if (!budget) continue;
                        let tail;
                        // Verify the boundary anchor even on same-sized rewrites; no history rescan.
                        tail = await readTail(file, id, old, budget, { completionMetadata: true });
                        bytes += tail.bytesRead;
                        if (tail.recovery.projected.length || tail.cursor.partialBytes > TAIL_LIMITS.maxLineBytes) {
                            bindPublicationSource(source, file, tail.recovery.sourceStamp);
                        }
                        const promptStartObserved = tail.cursor.droppedBytes === 0
                            && (!old || tail.reset || index.sources[id]?.promptStartObserved === true);
                        const firstPromptEventId = (tail.reset ? null : index.sources[id]?.firstPromptEventId)
                            ?? (promptStartObserved ? tail.events.find(event => event.type === "user.message")?.id : null);
                        const diagnostics = { credentialExclusions: 0, contextEvictions: 0, ...(saved?.diagnostics ?? {}) };
                        if (tail.events.length) {
                            for (const event of tail.events) {
                                const data = event.data, text = data?.arguments?.kickoff?.prompt;
                                if (event.type !== "external_tool.requested" || data?.toolName !== "create_session"
                                    || data.sessionId !== id || typeof event.id !== "string" || !Number.isFinite(Date.parse(event.timestamp))
                                    || typeof text !== "string" || !text || credential(text)) continue;
                                origins.set(event.id, { eventId: event.id, creatorSessionId: id, timestamp: event.timestamp, promptHash: promptHash(text) });
                            }
                            if (captureAnswers) answerCandidates.push(...collectRecordedAnswerCandidates(
                                filterDeletedEvents((tail.reset ? [] : saved?.events ?? []).concat(tail.events), id, state.deletion),
                                new Set(tail.events.map(event => event.id)), id,
                            ));
                            const incoming = tail.events.map(e => retainEvent(e, diagnostics, {
                                agentCreatedFirstMessage: source.promptCreation?.actor === "agent" && (!firstPromptEventId || e.id === firstPromptEventId),
                            })).flatMap(e => {
                                if (!e) return [];
                                if (credential(e)) {
                                    diagnostics.credentialExclusions++;
                                    return e.type === "user.message"
                                        ? [historyGap(`wire-gap-${hash(e.id)}`, "credential-excluded")] : [];
                                }
                                return [e];
                            });
                            const retained = restoreRetainedInteractionModelMetadata(tail.reset ? [] : saved?.events ?? [], records, id).map(event =>
                                event.type === "user.message" && event.data?.wirePromptAuthorship === undefined
                                    ? { ...event, data: { ...event.data, wirePromptAuthorship: { actor: "unknown", basis: "legacy-missing" } } } : event);
                            const modelEvents = filterDeletedEvents(retained.concat(incoming), id, state.deletion);
                            const unique = new Map();
                            for (const event of modelEvents) {
                                const previous = unique.get(event.id);
                                const conflict = previous?.type === "user.message" && event.type === "user.message"
                                    && (previous.timestamp !== event.timestamp || previous.data?.content !== event.data?.content
                                        || previous.data?.wirePromptCapture?.conflict);
                                unique.set(event.id, conflict && event.data?.wirePromptCapture ? { ...event, data: {
                                    ...event.data, wirePromptCapture: { ...event.data.wirePromptCapture, conflict: true },
                                    wirePromptAuthorship: promptAuthorship.merge(promptRecord(previous), promptRecord(event)),
                                } } : event);
                            }
                            const events = filterDeletedEvents([...unique.values()], id, state.deletion);
                            const partialWindow = tail.cursor.droppedBytes > 0 || tail.cursor.malformedLines > 0
                                || tail.cursor.oversizedLines > 0 || diagnostics.contextEvictions > 0 || diagnostics.credentialExclusions > 0
                                || diagnostics.unsupportedPromptContents > 0;
                            const workiq = extractScenarios(events, source, since, until, { partialWindow, modelEvents });
                            const graph = extractGraphActivities(events, source, { since, until, partialWindow, modelEvents });
                            records = mergedRecords(records, alignPromptUpdates(records, [...workiq.scenarios, ...graph.scenarios]));
                            const completions = new Map(incoming.filter(e => e.type === "tool.execution_complete").map(e => [e.data.toolCallId, e]));
                            const incomingStarts = new Map();
                            for (const start of incoming.filter(event => event.type === "tool.execution_start")) {
                                if (!incomingStarts.has(start.data.toolCallId)) incomingStarts.set(start.data.toolCallId, []);
                                incomingStarts.get(start.data.toolCallId).push(start);
                            }
                            records = records.map(record => {
                                if (record.sourceSessionId !== id) return record;
                                const originalModelEvidence = recordedInteractionModels(modelEvents, record, { partialWindow });
                                return { ...record,
                                    ...(originalModelEvidence ? { originalModelEvidence } : {}),
                                    ...(events.some(event => event.type === "user.message" && event.id === record.userPrompt?.sourceEventId)
                                        && (record.responseTiming?.status !== "measured"
                                            || events.some(event => event.id === record.responseTiming.finalEventId))
                                        ? { responseTiming: recordedResponseTiming(events, record.userPrompt) } : {}),
                                    toolCalls: (record.toolCalls ?? []).map(call => completions.has(call.toolCallId) && call.tool?.startsWith("workiq-")
                                        && !tail.reset && (incomingStarts.get(call.toolCallId) ?? [])
                                            .every(start => start.id === call.startEventId && start.timestamp === call.startedAt
                                                && isDeepStrictEqual(start.data.arguments, call.requestArgs)
                                                && (start.data.parentToolCallId ?? null) === call.parentToolCallId
                                                && (start.data.turnId ?? null) === call.turnId)
                                        ? completionUpdate(call, completeWorkIqCall(call, completions.get(call.toolCallId)), "toolCallId") : call),
                                    ...(record.graphActivities ? { graphActivities: record.graphActivities.map(activity => completions.has(activity.toolCallId)
                                        ? completionUpdate(activity, completeGraphActivity(activity, completions.get(activity.toolCallId),
                                            record.graphActivities.filter(a => a.toolCallId === activity.toolCallId && a.evidenceLevel !== "code-reference").length), "activityId")
                                        : activity) } : {}),
                                };
                            });
                            if (tail.recovery.projected.length && !tail.reset) {
                                const recovered = recoverSameReadCompletions({ sourceSessionId: id,
                                    sourceIdentity: tail.recovery.sourceIdentity, since, until,
                                    readStart: tail.recovery.readStart, readEnd: tail.recovery.readEnd,
                                    original: tail.recovery.original, projected: tail.recovery.projected,
                                    records, deletion: state.deletion });
                                if (recovered.dispositions.some(result => result.status === "recovered")) {
                                    records = recovered.records;
                                    bindPublicationSource(source, file, tail.recovery.sourceStamp);
                                }
                            }
                            records = filterDeletedRecords(records, state.deletion);
                            pending.push([checkpointPath, { schemaVersion: 1, cursor: tail.cursor, events: contextAfter(events, diagnostics), diagnostics }]);
                        } else if (!saved || tail.cursor.offset !== old.offset || tail.reset) {
                            pending.push([checkpointPath, { schemaVersion: 1, cursor: tail.cursor, events: tail.reset ? [] : saved?.events ?? [], diagnostics }]);
                        }
                        index.sources[id] = { scanned: true, logBytes: info.size, fileStamp: stamp, cursor: tail.cursor, diagnostics,
                            ...(index.sources[id]?.backfill ? { backfill: index.sources[id].backfill } : {}),
                            promptStartObserved, firstPromptEventId,
                            promptQualification: tail.reset || index.sources[id]?.error ? undefined : index.sources[id]?.promptQualification,
                            promptEventQualification: tail.reset || index.sources[id]?.error ? undefined : index.sources[id]?.promptEventQualification,
                            error: null, errorCode: null, lastCheckedAt: until, lastAttemptAt: until };
                    } catch (error) {
                        bytes += error.bytesRead ?? 0;
                        index.sources[id] = { ...index.sources[id], error: error instanceof BoardError ? error.message : `Source unavailable (${error.code ?? "READ_FAILED"}). Prior evidence retained.`, errorCode: error.code ?? "SOURCE_READ_FAILED", lastAttemptAt: until };
                    }
                    checked++;
                }
                // Only already-consumed, approved events participate. Never reopen a parent's history here.
                const originLimit = 2000;
                index.promptOrigins = [...origins.values()].slice(-originLimit);
                index.metrics.promptOriginEvictions = (index.metrics.promptOriginEvictions ?? 0) + Math.max(0, origins.size - originLimit);
                const sources = new Map(eligible.map(source => [source.sessionId, source]));
                records = records.map(record => {
                    const source = sources.get(record.sourceSessionId), prompt = record.userPrompt;
                    const creator = source?.promptCreation?.creatorSessionId;
                    if (!creator || !prompt?.text || prompt.sourceEventId !== index.sources[record.sourceSessionId]?.firstPromptEventId) return record;
                    const matchingCreators = eligible.filter(candidate => candidate.sessionId === creator || candidate.appId === creator || candidate.workspaceIds.includes(creator));
                    if (matchingCreators.length !== 1) return record;
                    const match = index.promptOrigins.some(origin => origin.creatorSessionId === matchingCreators[0].sessionId
                        && origin.timestamp <= prompt.sourceTimestamp && origin.promptHash === promptHash(prompt.text));
                    return match ? { ...record, userPrompt: { ...prompt, authorship: promptAuthorship.correlateKickoff(prompt) } } : record;
                });
                // Recover only author metadata for exact retained messages, within the existing
                // source/window/cycle bounds. An omitted field in a stripped checkpoint is not a user source.
                const qualifiedSources = new Set();
                for (const source of eligible) {
                    if (access) { await access.assertCollectionLease(acquisition); assertAcquisitionCurrent(); }
                    if (qualifiedSources.size >= 2 || bytes + TAIL_LIMITS.chunkBytes + 131328 > TAIL_LIMITS.cycleBytes) break;
                    const scoped = records.filter(record => record.sourceSessionId === source.sessionId
                        && record.userPrompt?.sourceEventId && typeof record.userPrompt.text === "string"
                        && record.userPrompt.sourceTimestamp >= since && record.userPrompt.sourceTimestamp <= until);
                    const candidates = scoped.filter(record => (record.userPrompt.authorshipVersion ?? 0) < automaticPromptQualificationVersion
                        && ["legacy-missing", "missing-source", "invalid-source", "unsupported-source"].includes(promptAuthorship.read(record.userPrompt).basis));
                    if (!candidates.length) continue;
                    const sourceCheckpoint = index.sources[source.sessionId];
                    const identity = sourceCheckpoint?.error ? null : sourceCheckpoint?.cursor?.identity ?? null;
                    const targetKeys = candidates.map(record => hash(JSON.stringify([
                        record.userPrompt.sourceEventId, record.userPrompt.sourceTimestamp, promptHash(record.userPrompt.text),
                    ]))).sort();
                    const prior = sourceCheckpoint?.promptEventQualification;
                    const priorTargets = new Set(prior?.targetKeys ?? []);
                    const reusable = prior?.lookupVersion === PROMPT_LOOKUP_VERSION && prior?.classifierVersion === promptAuthorship.version && prior?.identity === identity
                        && targetKeys.every(key => priorTargets.has(key));
                    if (reusable && prior.status !== "pending") continue;
                    const result = await qualifyRetainedPromptEvents(config, source, candidates, reusable ? prior : undefined, TAIL_LIMITS.cycleBytes - bytes);
                    bytes += result.bytesRead; qualifiedSources.add(source.sessionId);
                    index.sources[source.sessionId] = { ...sourceCheckpoint,
                        ...(result.checkpoint?.firstPromptEventId ? { firstPromptEventId: result.checkpoint.firstPromptEventId, promptStartObserved: true } : {}),
                        promptEventQualification: { ...result.checkpoint, lookupVersion: PROMPT_LOOKUP_VERSION, classifierVersion: promptAuthorship.version, identity,
                            targetKeys: reusable ? prior.targetKeys : targetKeys } };
                    const updates = new Map(result.updates.map(update => [update.eventId, update.authorship]));
                    records = records.map(record => record.sourceSessionId === source.sessionId && updates.has(record.userPrompt?.sourceEventId)
                        ? { ...record, userPrompt: { ...record.userPrompt, authorshipVersion: promptAuthorship.version, authorship: promptAuthorship.merge(record.userPrompt,
                            { authorship: updates.get(record.userPrompt.sourceEventId) }) } } : record);
                }
                for (const source of eligible) {
                    if (access) { await access.assertCollectionLease(acquisition); assertAcquisitionCurrent(); }
                    if (bytes + TAIL_LIMITS.chunkBytes + 131328 > TAIL_LIMITS.cycleBytes) break;
                    if (qualifiedSources.size >= 2 && !qualifiedSources.has(source.sessionId)) continue;
                    const creatorId = source.promptCreation?.creatorSessionId;
                    const candidates = records.filter(record => record.sourceSessionId === source.sessionId
                        && record.userPrompt?.sourceEventId && record.userPrompt.sourceTimestamp >= since
                        && record.userPrompt.sourceTimestamp <= until
                        && (["legacy-missing", "missing-source"].includes(promptAuthorship.read(record.userPrompt).basis)
                            || record.userPrompt.sourceEventId === index.sources[source.sessionId]?.firstPromptEventId
                                && promptAuthorship.read(record.userPrompt).actor === "user"));
                    const prior = index.sources[source.sessionId]?.promptQualification;
                    if (!creatorId || !candidates.length) continue;
                    const creators = eligible.filter(candidate => candidate.sessionId === creatorId || candidate.appId === creatorId || candidate.workspaceIds.includes(creatorId));
                    if (creators.length !== 1) continue;
                    const creatorCheckpoint = index.sources[creators[0].sessionId];
                    const creatorIdentity = creatorCheckpoint?.error ? null : creatorCheckpoint?.cursor?.identity ?? null;
                    if (prior && prior.status !== "pending" && prior.creatorIdentity === creatorIdentity) continue;
                    const result = await qualifyRetainedKickoff(config, source, creators[0], candidates,
                        prior?.creatorIdentity === creatorIdentity ? prior : undefined, TAIL_LIMITS.cycleBytes - bytes);
                    bytes += result.bytesRead; qualifiedSources.add(source.sessionId);
                    index.sources[source.sessionId] = { ...index.sources[source.sessionId],
                        promptQualification: { ...result.checkpoint, creatorIdentity } };
                    if (result.authorship) records = records.map(record => record.sourceSessionId === source.sessionId
                        && record.userPrompt?.sourceEventId === result.eventId
                        ? { ...record, userPrompt: { ...record.userPrompt, authorship: result.authorship } } : record);
                }
                const attributedPrompts = new Map(records.filter(record => record.userPrompt?.authorship)
                    .map(record => [JSON.stringify([record.sourceSessionId, record.userPrompt.sourceEventId]), record.userPrompt]));
                records = records.map(record => !record.followUpPrompts?.length ? record : { ...record,
                    followUpPrompts: record.followUpPrompts.map(prompt => {
                        const origin = attributedPrompts.get(JSON.stringify([record.sourceSessionId, prompt.sourceEventId]));
                        return origin && origin.sourceTimestamp === prompt.sourceTimestamp && origin.text === prompt.text
                            ? { ...prompt, authorship: promptAuthorship.merge(prompt, origin),
                                ...(origin.authorshipVersion ? { authorshipVersion: Math.max(prompt.authorshipVersion ?? 1, origin.authorshipVersion) } : {}) } : prompt;
                    }),
                });
                if (responseTimingJob?.phase === "pending") {
                    const job = responseTimingJob, selected = records.filter(record => job.scenarioIds.includes(record.scenarioId));
                    if (job.configVersion !== configVersion || job.deletionVersion !== activityDeletionVersion(state)
                        || selected.length !== job.scenarioIds.length || timingIdentity(selected) !== job.membership) {
                        job.phase = "invalidated"; job.error = "Selected evidence or source scope changed. Nothing was restored.";
                        job.scenarioIds = []; job.results = []; responseTimingCheckpoints.clear();
                    } else {
                        let sources = 0;
                        for (const sourceId of new Set(selected.map(record => record.sourceSessionId))) {
                            const source = eligible.find(source => source.sessionId === sourceId);
                            const owned = selected.filter(record => record.sourceSessionId === sourceId);
                            if (!source) {
                                for (const record of owned) if (!job.results.some(result => result.scenarioId === record.scenarioId)) {
                                    job.results.push({ scenarioId: record.scenarioId, status: "unavailable", reason: "source-not-eligible" });
                                }
                                continue;
                            }
                            if (owned.every(record => job.results.some(result => result.scenarioId === record.scenarioId))) continue;
                            if (sources >= 2 || bytes + TAIL_LIMITS.chunkBytes + 65792 > TAIL_LIMITS.cycleBytes) break;
                            const result = await qualifyRetainedResponseTimings(config, source, owned,
                                responseTimingCheckpoints.get(sourceId), TAIL_LIMITS.cycleBytes - bytes, since);
                            bytes += result.bytesRead; sources++;
                            responseTimingCheckpoints.set(sourceId, result.checkpoint);
                            if (result.checkpoint.status !== "complete") continue;
                            for (const record of owned) {
                                const timing = result.checkpoint.timings[record.userPrompt?.sourceEventId]
                                    ?? { schemaVersion: 1, status: "unavailable", reason: "outside-approved-window" };
                                job.results.push({ scenarioId: record.scenarioId, status: timing.status, reason: timing.reason });
                                if (timing.status === "measured") records = records.map(current => current.scenarioId === record.scenarioId
                                    ? { ...current, responseTiming: timing } : current);
                            }
                        }
                    }
                }
                // Prefix work runs after every live-tail and existing qualification opportunity.
                try {
                    backfillPrevious = await loadBackfillCheckpoint(root);
                    const options = { fingerprint, deletionVersion: activityDeletionVersion(state),
                        sources: eligible.map(source => ({ ...source, ...index.sources[source.sessionId] })),
                        availableBytes: Math.max(0, TAIL_LIMITS.cycleBytes - bytes),
                        mode: manual ? "manual" : "automatic", enabled: config.enabled,
                        globalPaused: !manual && access ? !access.collectionAvailable() : false,
                        automaticAvailable: !access || access.collectionAvailable(), manualAvailable: manual,
                        backfillAttempted: false };
                    let selection = selectBackfillWork(backfillPrevious?.checkpoint, options);
                    if (selection.clearContext && backfillPrevious && selection.kind === "state-only") {
                        backfillNext = stageBackfillReset(backfillPrevious.checkpoint, selection);
                        selection = selectBackfillWork(backfillNext, options);
                    }
                    if (selection.kind === "read") {
                        if (access) await access.assertCollectionLease(acquisition);
                        assertAcquisitionCurrent();
                        const source = eligible.find(source => source.sessionId === selection.sessionId);
                        const file = files.historyFile(selection.sessionId);
                        const read = await readBackfillChunk(file, selection);
                        bytes += read.bytesRead;
                        const diagnostics = { credentialExclusions: 0, contextEvictions: 0, ...selection.diagnostics };
                        const firstPromptEventId = index.sources[source.sessionId]?.firstPromptEventId
                            ?? (!selection.cursor ? read.events.find(event => event.type === "user.message")?.id : undefined);
                        if (firstPromptEventId) index.sources[source.sessionId].firstPromptEventId = firstPromptEventId;
                        const incoming = read.events.map(event => retainEvent(event, diagnostics, {
                            agentCreatedFirstMessage: source.promptCreation?.actor === "agent"
                                && (!firstPromptEventId || event.id === firstPromptEventId),
                        })).flatMap(event => {
                            if (!event) return [];
                            if (!credential(event)) return [event];
                            diagnostics.credentialExclusions++;
                            return event.type === "user.message"
                                ? [historyGap(`wire-gap-${hash(event.id)}`, "credential-excluded")] : [];
                        });
                        const events = filterDeletedEvents([...new Map(
                            filterDeletedEvents(selection.context.concat(incoming), source.sessionId, state.deletion).map(event => [event.id, event]),
                        ).values()], source.sessionId, state.deletion);
                        const workiq = extractScenarios(events, source, since, until, { partialWindow: true, firstPromptEventId });
                        const graph = extractGraphActivities(events, source, { since, until, partialWindow: true, firstPromptEventId });
                        const updates = alignPromptUpdates(records, [...workiq.scenarios, ...graph.scenarios]);
                        records = filterDeletedRecords(mergedRecords(records, updates), state.deletion);
                        backfillNext = stageBackfillProgress(selection, read, { events: contextAfter(events, diagnostics), diagnostics });
                        bindPublicationSource(source, file, read.sourceStamp);
                    } else if (selection.clearContext && backfillPrevious && !backfillNext) {
                        backfillNext = stageBackfillReset(backfillPrevious.checkpoint, selection);
                    }
                    backfillState = backfillNext ?? backfillPrevious?.checkpoint ?? null;
                } catch (error) {
                    bytes += error.bytesRead ?? 0;
                    if (!["BACKFILL_CHECKPOINT_CLEANUP_REQUIRED", "BACKFILL_CHECKPOINT_CHANGED", "BACKFILL_GENERATION_CHANGED",
                        "ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
                    backfillProblem = error.code;
                    backfillNext = null;
                    backfillState = backfillPrevious?.checkpoint ?? null;
                    console.warn("[workiq-collector] backfill deferred", { code: error.code });
                }
                const prefixRows = new Map(backfillState?.backfill.sources.map(row => [row.sessionId, row]) ?? []);
                for (const source of eligible) {
                    const row = index.sources[source.sessionId];
                    if (!row) continue;
                    const prefix = prefixRows.get(source.sessionId);
                    if (prefix) row.backfill = { ...row.backfill, phase: prefix.phase, omittedBytes: prefix.endOffset,
                        boundaryGap: Boolean(row.backfill?.boundaryGap || prefix.boundaryGap),
                        ...(backfillState?.backfillSource === source.sessionId ? {
                            malformedLines: Math.max(row.backfill?.malformedLines ?? 0, backfillState.cursor.malformedLines),
                            oversizedLines: Math.max(row.backfill?.oversizedLines ?? 0, backfillState.cursor.oversizedLines),
                            contextEvictions: Math.max(row.backfill?.contextEvictions ?? 0, backfillState.diagnostics.contextEvictions ?? 0),
                        } : {}) };
                    row.backfillPending = !row.error && row.cursor?.droppedBytes > 0
                        && (!prefix || ["pending", "reading"].includes(prefix.phase));
                }
                index.backfill = { ...backfillProgressSummary(backfillState),
                    pendingSources: eligible.filter(source => index.sources[source.sessionId]?.backfillPending).length,
                    ...(backfillProblem ? { problem: backfillProblem } : {}) };
                rotation = eligible.length ? (rotation + checked) % eligible.length : 0;
                const eligibility = discovery.roster.map(r => [r.sessionId, r.eligible, r.disposition, r.projectId, r.project, r.projectType, r.name]);
                const eligibilityHash = hash(JSON.stringify([fingerprint, eligibility, config.windowDays]));
                const changed = initialRecords !== JSON.stringify(records);
                const historyCoverage = historyStatus.coverage(discovery.roster,
                    Object.entries(index.sources).map(([sessionId, row]) => ({ sessionId, ...row }))).summary;
                const historyHash = hash(JSON.stringify(historyCoverage));
                const coverageChanged = state.importCoverage?.dynamic?.eligibilityHash !== eligibilityHash
                    || state.importCoverage?.dynamic?.historyHash !== historyHash;
                const commit = async () => {
                    await assertCollectorLockOwned(dir);
                    await revalidateMetadata();
                    const strictPublication = publicationSources.size > 0 || backfillNext !== null;
                    let expectedRevision = state.revision, expectedEvidenceRevision = state.evidenceRevision ?? state.revision;
                    request?.dispatched();
                    publicationStarted = true;
                    index.ownerHost = files.ownerHost;
                    publicationOwnerHost = files.ownerHost;
                    // Keep the in-process floor even if publication fails with an uncertain result.
                    indexVersionFloor = 3;
                    await installCollectorIndexBarrier(root, assertAcquisitionCurrent, files.ownerHost);
                    index = withCollectorIndexBarrier(index);
                    assertAcquisitionCurrent();
                    if (changed || coverageChanged) {
                        const imported = collectionCoverage(discovery, index.sources, records, since, until);
                        imported.dynamic.eligibilityHash = eligibilityHash;
                        imported.dynamic.historyHash = historyHash;
                        imported.dynamic.historyCoverage = historyCoverage;
                        // Rebase on current evidence inside the writer queue: recorder/review writes are never lost.
                        if (publicationSources.size || backfillNext) {
                            await exclusiveBoard(session, async (current, save) => {
                                await assertCollectorLockOwned(dir);
                                await revalidateMetadata();
                                if (current.revision !== state.revision || activityDeletionVersion(current) !== activityDeletionVersion(state)) {
                                    throw Object.assign(new BoardError("Stored activity changed before bounded history publication. No stale recovery was applied.", 409),
                                        { code: "COLLECTION_RECORDS_CHANGED" });
                                }
                                await stageEvidenceSnapshot(session, current, {
                                    records: filterDeletedRecords(mergedRecords(current.evidence ?? [], records), current.deletion),
                                    importCoverage: imported,
                                });
                                current.revision++;
                                await save(current, assertPublicationCurrent, revalidateMetadata);
                                expectedRevision = current.revision;
                                expectedEvidenceRevision = current.evidenceRevision ?? current.revision;
                            });
                        } else await replaceEvidence(session, current => ({ records: mergedRecords(current, records), importCoverage: imported }));
                        if (changed) index.lastNewDataAt = until;
                    }
                    const captureCounts = answerCandidates.length ? await commitRecordedAnswers(session, answerCandidates, {
                        consentRevision: state.personalEvaluation.consent.revision, source: assessmentSource(state, config),
                    }) : { captured: 0, excluded: 0, suppressed: 0, unassociated: 0 };
                    if (captureCounts.captured) { expectedRevision++; expectedEvidenceRevision++; }
                    const finishPublication = async lockedState => {
                        if (backfillNext) {
                            await revalidateMetadata();
                            await publishBackfillCheckpoint(root, backfillPrevious, backfillNext,
                                { assertCurrent: assertPublicationCurrent, preparePublication: revalidateMetadata });
                        }
                        // Evidence commits before cursor advancement. A crash here safely replays idempotent IDs.
                        for (const [file, checkpoint] of pending) await atomicJson(file, checkpoint, {
                            assertCurrent: publicationSources.has(path.basename(file, ".json")) ? assertPublicationCurrent : assertAcquisitionCurrent,
                            ...(publicationSources.has(path.basename(file, ".json")) ? { preparePublication: revalidateMetadata } : {}),
                        });
                        index.lastCheckedAt = until;
                        index.metrics = { totalBytesRead: index.metrics.totalBytesRead + bytes, cycles: index.metrics.cycles + 1,
                            lastBytesRead: bytes, lastSourcesChecked: checked, lastDurationMs: Date.now() - start, assessmentCapture: captureCounts };
                        if (pending.length || backfillNext || coverageChanged || !isDeepStrictEqual(index.ownerHost, previousIndex.ownerHost)
                            || checkpointIdentity(index) !== checkpointIdentity(previousIndex)
                            || JSON.stringify(index.backfill) !== JSON.stringify(previousIndex.backfill)) {
                            await atomicJson(path.join(root, "index.json"), index,
                                { assertCurrent: assertPublicationCurrent, preparePublication: revalidateMetadata });
                        }
                        if (responseTimingJob?.phase === "pending" && responseTimingJob.results.length === responseTimingJob.scenarioIds.length) {
                            responseTimingJob.phase = "complete";
                            responseTimingCheckpoints.clear();
                        }
                        const committedState = lockedState ?? await loadBoardState(session);
                        stateChanged = beforeIdentity !== stateIdentity(committedState);
                        const check = {
                            schemaVersion: 2, id: checkId, startedAt: new Date(start).toISOString(), completedAt: dateNow(),
                            configVersion, beforeRevision: state.revision, revision: committedState.revision,
                            changes: changed ? evidenceChanges(state.evidence ?? [], records) : { added: 0, updated: 0, items: [] }, coverageChanged,
                            coverage: historyCoverage, sourcesChecked: checked, eligibleSources: eligible.length,
                            pendingSources: historyCoverage.pending, partialSources: eligible.filter(source => index.sources[source.sessionId]?.cursor?.partialBytes).length,
                            skippedSources: discovery.counts.skippedByLimit,
                        };
                        check.outcome = historyCoverage.affected || check.pendingSources || check.partialSources || check.skippedSources || checked < eligible.length ? "partial" : "complete";
                        if (manual) {
                            await atomicJson(path.join(root, "last-check.json"), check,
                                { assertCurrent: assertPublicationCurrent, preparePublication: revalidateMetadata });
                            lastCheck = check;
                            lastCheckWarning = null;
                        }
                        lastError = null;
                        return check;
                    };
                    if (strictPublication) return exclusiveBoard(session, async current => {
                        await assertCollectorLockOwned(dir);
                        await revalidateMetadata();
                        if (current.revision !== expectedRevision || (current.evidenceRevision ?? current.revision) !== expectedEvidenceRevision
                            || activityDeletionVersion(current) !== activityDeletionVersion(state)) {
                            throw Object.assign(new BoardError("Stored activity changed before bounded progress publication. No stale cursor was admitted.", 409),
                                { code: "COLLECTION_RECORDS_CHANGED" });
                        }
                        return finishPublication(current);
                    });
                    return finishPublication();
                };
                await revalidateMetadata();
                return await (access ? access.admitCollection(acquisition, commit) : commit());
            } catch (error) {
                if (responseTimingJob?.phase === "pending") {
                    responseTimingJob.phase = "failed";
                    responseTimingJob.error = "Metadata qualification failed. Read current facts; the request will not be replayed.";
                    responseTimingJob.results = [];
                    responseTimingCheckpoints.clear();
                }
                index = indexVersionFloor >= 2 ? withCollectorIndexBarrier({
                    ...previousIndex, ...(publicationOwnerHost ? { ownerHost: publicationOwnerHost } : {}),
                }) : previousIndex;
                if (publicationStarted && error.code !== "wire_access_admission_failed") {
                    error = Object.assign(new BoardError("Collection publication was interrupted after dispatch. Read current state before another check; nothing was replayed.", 409),
                        { code: "wire_access_admission_failed", cause: error });
                }
                connected = false;
                lastError = error instanceof BoardError ? error.message : `Collection failed (${error.code ?? "INTERNAL"}). Last good evidence and checkpoints retained.`;
                console.error("[workiq-collector] collection failed", { code: error.code ?? "COLLECTION_FAILED" });
                throw error;
            }
        })();
        let check;
        try { check = await running; }
        finally { running = null; schedule(); }
        // A completed source check need not change the board. Keep checkpoint timing
        // out of this signal, but include retained text, coverage and authorization.
        try { await onCommitted(check, { stateChanged }); }
        catch (error) {
            console.error("[workiq-collector] post-commit observer failed", { code: error.code ?? "COLLECTION_OBSERVER_FAILED" });
        }
        return { ...await api.status(), check };
    }
    const api = {
        async qualifyInteractionModels(input) {
            if (access) throw Object.assign(new BoardError("Metadata qualification admission is not integrated.", 503), { code: "wire_access_writer_integration_pending" });
            return changeSetting(async () => {
                if (running) await running;
                if (closed || !config?.approved || !config.enabled) throw new BoardError("Approved interval collection must already be enabled; no setting was changed.", 428);
                if (!input || Object.keys(input).some(key => !["operationId", "scenarioIds", "expectedSourceRevision"].includes(key))
                    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.operationId ?? "")
                    || !Array.isArray(input.scenarioIds) || !input.scenarioIds.length || input.scenarioIds.length > 6
                    || input.scenarioIds.some(id => typeof id !== "string" || !id || id.length > 300)
                    || new Set(input.scenarioIds).size !== input.scenarioIds.length
                    || !Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0) {
                    throw new BoardError("Choose at most six exact retained requests and their current source revision.", 422);
                }
                const inputHash = hash(JSON.stringify([input.operationId, [...input.scenarioIds].sort(), input.expectedSourceRevision]));
                const current = await loadBoardState(session);
                const prior = [modelQualification, current.originalModelQualification].find(value => value?.operationId === input.operationId);
                if (prior) {
                    if (prior.inputHash !== inputHash) throw new BoardError("Metadata operation identity was reused for a different scope.", 409);
                    return modelStatus(prior);
                }
                if ((current.evidenceRevision ?? current.revision) !== input.expectedSourceRevision) throw new BoardError("Source evidence changed. Read current facts before qualifying metadata.", 409);
                const since = new Date(Date.now() - config.windowDays * 86400000).toISOString(), until = dateNow();
                const selected = (current.evidence ?? []).filter(record => input.scenarioIds.includes(record.scenarioId));
                if (selected.length !== input.scenarioIds.length || selected.some(record => record.assessmentMembershipPruned
                    || !record.userPrompt?.sourceEventId || !Number.isFinite(Date.parse(record.userPrompt.sourceTimestamp))
                    || record.userPrompt.sourceTimestamp < since || record.userPrompt.sourceTimestamp > until)) {
                    throw new BoardError("The selected retained request membership is incomplete or outside the approved window.", 409);
                }
                if (selected.some(record => selected.some(other => other.sourceSessionId === record.sourceSessionId
                    && other.userPrompt.sourceEventId === record.userPrompt.sourceEventId
                    && other.userPrompt.sourceTimestamp !== record.userPrompt.sourceTimestamp))) {
                    throw new BoardError("Selected prompt aliases have conflicting timestamps. No model metadata was changed.", 409);
                }
                const sourceIds = [...new Set(selected.map(record => record.sourceSessionId))];
                if (sourceIds.length > 2) throw new BoardError("Qualify at most two exact source chats in one bounded operation.", 422);
                const roster = (await discoverSources(config)).roster;
                if (sourceIds.some(id => !roster.some(source => source.sessionId === id && source.eligible))) {
                    throw new BoardError("A selected source is no longer eligible. No model metadata was changed.", 409);
                }
                const membership = timingIdentity(selected), deletionVersion = activityDeletionVersion(current);
                const configVersion = hash(JSON.stringify(config)), candidates = new Map(), stamps = [];
                modelQualification = { version: 1, operationId: input.operationId, inputHash, phase: "pending",
                    requested: selected.length, applied: 0, results: [], bytesRead: 0 };
                const fileStamp = info => [info.size, info.mtimeMs, info.ctimeMs, info.ino, info.birthtimeMs].join(":");
                const files = sourceHost(config);
                try {
                    for (const sourceId of sourceIds) {
                        const source = roster.find(source => source.sessionId === sourceId);
                        const owned = selected.filter(record => record.sourceSessionId === sourceId);
                        const stamp = fileStamp(await stat(files.historyFile(sourceId)));
                        const result = await qualifyRetainedInteractionModels(config, source, owned, undefined,
                            TAIL_LIMITS.cycleBytes - modelQualification.bytesRead, since);
                        modelQualification.bytesRead += result.bytesRead;
                        const changed = fileStamp(await stat(files.historyFile(sourceId))) !== stamp;
                        stamps.push({ sourceId, stamp });
                        for (const record of owned) {
                            const evidence = result.checkpoint.models[record.userPrompt.sourceEventId];
                            const fact = evidence ? interactionModelFact({ ...record, originalModelEvidence: evidence }) : null;
                            const allowed = evidence && filterDeletedRecords([{ ...record, originalModelEvidence: evidence }], current.deletion)[0]?.originalModelEvidence;
                            const reason = changed ? "source-changed" : result.checkpoint.status !== "complete" ? "metadata-byte-bound"
                                : result.checkpoint.reason ?? (!evidence ? "interaction-link-unavailable"
                                    : !isDeepStrictEqual(allowed, evidence) ? "deleted-model-dependency"
                                    : evidence.truncated ? "model-evidence-limit"
                                    : !["recorded", "partial"].includes(fact.status) ? fact.status : null);
                            modelQualification.results.push({ status: reason ? "unavailable" : fact.status, reason });
                            if (!reason) candidates.set(record.scenarioId, evidence);
                        }
                    }
                    if (candidates.size !== selected.length) {
                        modelQualification.phase = "unavailable";
                        modelQualification.error = "No model metadata was changed. Every selected request must have supported original model evidence within the read bounds.";
                        return modelStatus(modelQualification);
                    }
                    const latestRoster = (await discoverSources(config)).roster;
                    if (sourceIds.some(id => !latestRoster.some(source => source.sessionId === id && source.eligible))
                        || (await Promise.all(stamps.map(async entry =>
                            fileStamp(await stat(files.historyFile(entry.sourceId))) === entry.stamp))).some(same => !same)) {
                        throw new BoardError("Selected source metadata changed during qualification. Nothing was restored.", 409);
                    }
                    const receipt = { ...modelQualification, phase: "complete",
                        applied: selected.filter(record => !isDeepStrictEqual(record.originalModelEvidence, candidates.get(record.scenarioId))).length };
                    if (!receipt.applied) {
                        if ((await loadBoardState(session)).evidenceRevision !== input.expectedSourceRevision) {
                            throw new BoardError("Source evidence changed during qualification. Nothing was restored.", 409);
                        }
                        modelQualification = receipt;
                        return modelStatus(receipt);
                    }
                    await updateBoardState(session, async state => {
                        const retained = (state.evidence ?? []).filter(record => input.scenarioIds.includes(record.scenarioId));
                        if (closed || !config?.approved || !config.enabled
                            || state.evidenceRevision !== input.expectedSourceRevision || timingIdentity(retained) !== membership
                            || activityDeletionVersion(state) !== deletionVersion || hash(JSON.stringify(config)) !== configVersion) {
                            throw new BoardError("Source evidence changed during qualification. Nothing was restored.", 409);
                        }
                        if (receipt.applied) {
                            const continuation = state.continuation;
                            await stageEvidenceSnapshot(session, state, {
                                records: state.evidence.map(record => candidates.has(record.scenarioId)
                                    ? { ...record, originalModelEvidence: candidates.get(record.scenarioId) } : record),
                                importCoverage: state.importCoverage,
                            });
                            state.continuation = continuation;
                        }
                        // Receipt and evidence pointer commit together; a lost response can be retried after restart.
                        state.originalModelQualification = receipt;
                    });
                    modelQualification = receipt;
                    try { await onCommitted(null, { stateChanged: true, kind: "model-metadata" }); }
                    catch (error) {
                        console.error("[workiq-collector] post-commit observer failed", { code: error.code ?? "COLLECTION_OBSERVER_FAILED" });
                    }
                    return modelStatus(receipt);
                } catch (error) {
                    modelQualification.phase = "failed";
                    modelQualification.error = error instanceof BoardError ? error.message
                        : `Model metadata qualification failed (${error.code ?? "READ_FAILED"}). No model metadata was committed.`;
                    console.error("[workiq-collector] model metadata qualification failed", { code: error.code ?? "MODEL_QUALIFICATION_FAILED" });
                    if (error instanceof BoardError) throw error;
                    throw new BoardError(modelQualification.error, 503);
                }
            });
        },
        async qualifyResponseTimings(input) {
            if (access) throw Object.assign(new BoardError("Timing qualification admission is not integrated.", 503), { code: "wire_access_writer_integration_pending" });
            return changeSetting(async () => {
                if (running) await running;
                if (closed || !config?.approved || !config.enabled) throw new BoardError("Approved interval collection must already be enabled; no setting was changed.", 428);
                if (!input || Object.keys(input).some(key => !["operationId", "scenarioIds", "expectedSourceRevision"].includes(key))
                    || !/^[a-f0-9-]{36}$/i.test(input.operationId ?? "")
                    || !Array.isArray(input.scenarioIds) || !input.scenarioIds.length || input.scenarioIds.length > 6
                    || input.scenarioIds.some(id => typeof id !== "string" || !id || id.length > 300)
                    || new Set(input.scenarioIds).size !== input.scenarioIds.length || !Number.isSafeInteger(input.expectedSourceRevision)) {
                    throw new BoardError("Choose at most six exact retained requests and their current source revision.", 422);
                }
                const inputHash = hash(JSON.stringify(input));
                if (responseTimingJob?.operationId === input.operationId) {
                    if (responseTimingJob.inputHash !== inputHash) throw new BoardError("Metadata operation identity was reused for a different scope.", 409);
                    return timingStatus();
                }
                if (responseTimingJob?.phase === "pending") throw new BoardError("A metadata qualification is already pending. Read its status.", 409);
                const current = await loadBoardState(session);
                if ((current.evidenceRevision ?? current.revision) !== input.expectedSourceRevision) throw new BoardError("Source evidence changed. Read current facts before qualifying metadata.", 409);
                const selected = (current.evidence ?? []).filter(record => input.scenarioIds.includes(record.scenarioId));
                if (selected.length !== input.scenarioIds.length || selected.some(record => record.assessmentMembershipPruned || !record.userPrompt?.sourceEventId)) {
                    throw new BoardError("The selected retained request membership is incomplete or no longer available.", 409);
                }
                responseTimingCheckpoints.clear();
                responseTimingJob = { operationId: input.operationId, inputHash, phase: "pending",
                    scenarioIds: [...input.scenarioIds], membership: timingIdentity(selected), results: [],
                    configVersion: hash(JSON.stringify(config)), deletionVersion: activityDeletionVersion(current) };
                return timingStatus();
            });
        },
        approvedRecollectionSource() {
            if (access) throw Object.assign(new BoardError("Recollection admission is not integrated.", 503), { code: "wire_access_writer_integration_pending" });
            if (closed || !config?.approved) throw new BoardError("Connect and approve a local Copilot source before recollecting.", 428);
            const copy = structuredClone(config);
            shareSourceHost(config, copy);
            return copy;
        },
        assessmentSource(state) { return assessmentSource(state, config); },
        exclusiveActivity(work) {
            return changeSetting(async () => {
                if (running) await running;
                return work();
            });
        },
        async configure(input, admission) {
            const request = requestAdmission(admission);
            request?.check();
            if (access) {
                validateConfiguration(input);
                checkConfigVersion(input?.expectedConfigVersion);
                acquisitionEpoch++;
            }
            return changeSetting(async () => {
                if (closed) throw new BoardError("Collection runtime is stopped.", 409);
                await waitForRun();
                request?.check();
                checkConfigVersion(input?.expectedConfigVersion);
                validateConfiguration(input);
                const guard = await access?.read("collector-settings");
                let persisted = false;
                try {
                    await bindSourceHost(session, input);
                    if (access) await access.validateCollectionSource(input);
                    let rootInfo;
                    try { rootInfo = await stat(sourceHost(input).historyRoot()); }
                    catch (error) {
                        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
                        throw new BoardError(`The session-state directory could not be opened (${error.code}). Check the source path and local access. The current connection is unchanged.`, 422);
                    }
                    if (!rootInfo.isDirectory()) throw new BoardError("Choose a session-state directory.", 422);
                    const discovered = await discoverSources(input);
                    const verified = guard ? guard.publish(() => discovered) : discovered;
                    const persist = async () => {
                        request?.check();
                        request?.dispatched();
                        await mkdir(root, { recursive: true });
                        if (!config) {
                            const state = await loadBoardState(session);
                            await atomicJson(path.join(root, "before-dynamic-state.json"), state);
                        } else await copyFile(path.join(root, "config.json"), path.join(root, "previous-config.json"));
                        const { expectedConfigVersion, ...preferences } = input;
                        const next = { ...preferences, schemaVersion: 1, approvedAt: dateNow(), sourceAdapter: verified.adapter };
                        await atomicJson(path.join(root, "config.json"), next);
                        persisted = true;
                        shareSourceHost(input, next);
                        config = next; discovery = verified; discoveryAt = Date.now(); connected = true; lastError = null;
                        if (access) authorizationReady = false;
                        const currentState = await loadBoardState(session);
                        if (currentState.personalEvaluation) {
                            await updateBoardState(session, state => {
                                const source = assessmentSource(state, config);
                                if (JSON.stringify(state.personalEvaluation.source) !== JSON.stringify(source)) state.evidenceRevision++;
                                state.personalEvaluation.source = source;
                            });
                            invalidateAssessmentCache();
                        }
                    };
                    await (guard ? guard.admit(persist) : persist());
                    if (access) { await access.synchronizeCollection(config); authorizationReady = true; }
                    schedule();
                    return await (input.enabled && (!access || access.collectionAvailable())
                        ? run(true, false, request) : api.status());
                } catch (error) {
                    if (access && persisted) {
                        const failure = configurationOutcomeUnknown(); lastError = failure.message; throw failure;
                    }
                    throw error;
                } finally { guard?.release(); }
            });
        },
        async setEnabled(enabled, expectedConfigVersion, admission) {
            const request = requestAdmission(admission);
            request?.check();
            if (access) {
                if (closed || typeof enabled !== "boolean" || !config) throw new BoardError("Connect a source before changing collection.", 422);
                checkConfigVersion(expectedConfigVersion);
                acquisitionEpoch++;
            }
            return changeSetting(async () => {
            if (closed) throw new BoardError("Collection runtime is stopped.", 409);
            if (typeof enabled !== "boolean" || !config) throw new BoardError("Connect a source before changing collection.", 422);
            clearTimeout(timer);
            await waitForRun();
            request?.check();
            checkConfigVersion(expectedConfigVersion);
            const next = { ...config, enabled };
            const guard = await access?.read("collector-settings");
            let persisted = false;
            try {
                const persist = async () => {
                    request?.check();
                    request?.dispatched();
                    await atomicJson(path.join(root, "config.json"), next);
                    persisted = true;
                    shareSourceHost(config, next);
                    config = next;
                    if (access) authorizationReady = false;
                };
                await (guard ? guard.admit(persist) : persist());
                if (access) { await access.synchronizeCollection(config); authorizationReady = true; }
            } catch (error) {
                if (access && persisted) {
                    const failure = configurationOutcomeUnknown(); lastError = failure.message; throw failure;
                }
                throw error;
            } finally { guard?.release(); }
            schedule();
            return api.status();
            });
        },
        collectNow(admission, expectedBasis) {
            const request = requestAdmission(admission);
            request?.check();
            let expected;
            if (expectedBasis !== undefined) {
                if (!access || !expectedBasis || Object.getPrototypeOf(expectedBasis) !== Object.prototype
                    || Object.keys(expectedBasis).length !== 2 || !Object.hasOwn(expectedBasis, "generation") || !Object.hasOwn(expectedBasis, "configVersion")
                    || !Number.isSafeInteger(expectedBasis.generation) || expectedBasis.generation < 0
                    || typeof expectedBasis.configVersion !== "string" || !/^[a-f0-9]{64}$/.test(expectedBasis.configVersion)) {
                    throw Object.assign(new BoardError("The captured GitHub collection basis is invalid.", 422),
                        { code: "COLLECTION_EXPECTED_BASIS_INVALID" });
                }
                expected = Object.freeze({ ...expectedBasis });
            }
            assertExpectedBasis(expected);
            if (expected && manualCheck && (!manualCheckBasis || expected.configVersion !== manualCheckBasis.configVersion
                || expected.generation !== manualCheckBasis.generation)) {
                throw Object.assign(new BoardError("Another GitHub check does not carry this captured basis. No additional source check was started.", 409),
                    { code: "COLLECTION_EXPECTED_BASIS_CHANGED" });
            }
            // Manual callers share one reconciled cycle, never a possibly unreconciled background tail.
            if (!manualCheck) {
                manualCheckBasis = expected;
                manualCheck = changeSetting(async () => {
                    if (running) await running;
                    request?.check();
                    assertExpectedBasis(expected);
                    return run(true, true, request, expected);
                }).finally(() => { manualCheck = undefined; manualCheckBasis = undefined; });
            }
            return manualCheck.then(value => { request?.check(); return value; });
        },
        async status(revision) {
            const state = await loadBoardState(session);
            revision ??= state.revision;
            const activeIds = discovery ? new Set(discovery.roster.filter(r => r.eligible).map(r => r.sessionId)) : null;
            const sources = Object.entries(index.sources).filter(([id]) => !activeIds || activeIds.has(id)).map(([, value]) => value);
            const sum = read => sources.reduce((total, row) => total + (read(row) ?? 0), 0);
            const cursors = Object.entries(index.sources).map(([sessionId, value]) => ({ sessionId, ...value }));
            const history = historyStatus.coverage(discovery?.roster, cursors, (state.evidence ?? []).map(row => row.sourceSessionId));
            for (const issue of history.issues) {
                if (credential(issue.name)) issue.name = "Copilot chat name withheld";
                if (issue.project && credential(issue.project)) issue.project = "Project name withheld";
            }
            const lastCheckedAt = lastCheck?.configVersion === (config ? hash(JSON.stringify(config)) : null) && lastCheck.startedAt > (index.lastCheckedAt ?? "")
                ? lastCheck.startedAt : index.lastCheckedAt;
            const checkedWindow = config && index.fingerprint === hash(JSON.stringify([config.appDbPath, config.sessionRoot, config.windowDays])) && lastCheckedAt
                ? { since: new Date(Date.parse(lastCheckedAt) - config.windowDays * 86400000).toISOString(), until: lastCheckedAt }
                : null;
            return {
                state: closed ? "stopped" : !config ? "disconnected" : lastError ? "error" : running ? "collecting" : config.enabled ? "collecting-on-interval" : "paused",
                connected, config, configVersion: config ? hash(JSON.stringify(config)) : null,
                suggestedSource: config ? null : await detectSource(), error: lastError,
                revision, deletionVersion: activityDeletionVersion(state), artifactRevision: state.artifactDeletion?.revision ?? 0,
                lastCheckedAt, lastNewDataAt: index.lastNewDataAt, checkedWindow,
                lastCheck, lastCheckWarning,
                backfill: index.backfill ?? null,
                responseTimingQualification: timingStatus(),
                interactionModelQualification: modelStatus(modelQualification ?? state.originalModelQualification),
                cadence: { pollSeconds: config?.pollSeconds ?? 5, reconciliationSeconds: 30, browserPollSeconds: 5 },
                metrics: { ...index.metrics, backlogBytes: sum(r => r.cursor?.backlogBytes), partialSources: sources.filter(r => r.cursor?.partialBytes).length,
                    truncatedSources: sources.filter(r => r.cursor?.droppedBytes).length, rotations: sum(r => r.cursor?.rotations),
                    malformedLines: sum(r => (r.cursor?.malformedLines ?? 0) + (r.backfill?.malformedLines ?? 0)),
                    oversizedLines: sum(r => (r.cursor?.oversizedLines ?? 0) + (r.backfill?.oversizedLines ?? 0)),
                    credentialExclusions: sum(r => r.diagnostics?.credentialExclusions),
                    unsupportedPromptContents: sum(r => r.diagnostics?.unsupportedPromptContents),
                    contextEvictions: sum(r => (r.diagnostics?.contextEvictions ?? 0) + (r.backfill?.contextEvictions ?? 0)) },
                discovery: discovery ?? null, sourceErrors: discovery ? history.summary.unavailable : null,
                historyCoverage: discovery ? history.summary : null, historyIssues: history.issues,
                cursors,
                limits: TAIL_LIMITS,
            };
        },
        async close() {
            if (closing) return closing;
            closed = true; clearTimeout(timer);
            releaseAuthorization?.();
            closing = (async () => {
                await settings;
                if (manualCheck) await manualCheck.catch(() => {});
                if (running) await running.catch(() => {});
                controllers.delete(dir);
                try { await release(); }
                finally { timerScope?.emitDestroy(); }
            })();
            return closing;
        },
    };
    controllers.set(dir, api);
    releaseAuthorization = access?.subscribeCollection(schedule);
    schedule();
    return api;
}
