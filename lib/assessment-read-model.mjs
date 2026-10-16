import { createHash, createHmac } from "node:crypto";
import { buildExportCatalog } from "./export-selection.mjs";
import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { normalizeEndpoint } from "./analytics.mjs";
import { recordUnits, activityDeletionVersion } from "./deletion-identities.mjs";
import { time } from "./time.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import {
    BASIS_KEYS, DEFINITIONS, WORKIQ_TOOLS, ContractError, defaultConsent, validateConsent,
    validateObservation, validateInteractionView, validateMetric, metricSlotKey,
    poolMetrics, freezeReportFacts, METRIC_PROJECTION_VERSION,
} from "./assessment-contract.mjs";

export const assessmentHash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export function assessmentRef(state, kind, value) {
    if (!/^[a-f0-9]{64}$/.test(state.pseudonymKey)) throw new ContractError("invalid-pseudonym-key");
    return `${kind}-${createHmac("sha256", state.pseudonymKey).update(JSON.stringify(["wire-assessment-v1", kind, value])).digest("hex").slice(0, 32)}`;
}
export function assessmentBasis(state) {
    return {
        sourceRevision: state.evidenceRevision ?? state.revision, membershipRevision: state.evidenceRevision ?? state.revision,
        consentRevision: state.personalEvaluation?.consent?.revision ?? 0,
        overrideRevision: state.personalEvaluation?.overrideRevision ?? 0,
        deletionEpoch: activityDeletionVersion(state),
    };
}
export function assessmentSource(state, config) {
    if (!config?.approved) return { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    const hash = assessmentHash([config.appDbPath, config.sessionRoot, config.windowDays, config.sourceAdapter]);
    return { available: true, sourceConfigRef: assessmentRef(state, "sourceconfig", hash), sourceConfigRevision: parseInt(hash.slice(0, 12), 16) };
}
export function recordedInstant(value) {
    try { return new Date(time.instant(value)).toISOString(); }
    catch (error) { if (!(error instanceof RangeError)) throw error; return null; }
}
const distinct = values => [...new Set(values)];
const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
const capabilities = Object.freeze({ answer: true, usage: false, explicitAuthorization: false });
const caches = new Map();
export function invalidateAssessmentCache() { caches.clear(); }
export function finalizePersonalEvaluationCleanup(state, operationId) {
    for (const mutation of Object.values(state.personalEvaluation?.mutations ?? {})) {
        if (mutation.receipt.phase !== "pending" || mutation.receipt.operationId !== operationId) continue;
        mutation.receipt.phase = "complete";
        mutation.receipt.basis = assessmentBasis(state);
    }
    return state.personalEvaluation;
}
function baseMetric(state, basis, createdAt, definitionId, dimension, eligibleUnitRefs) {
    const definition = DEFINITIONS[definitionId];
    return {
        schemaVersion: 1, metricRef: assessmentRef(state, "metric", [definitionId, dimension, eligibleUnitRefs, basis]),
        definitionId, definitionVersion: definition.version, dimension, checkId: null, checkVersion: null,
        unit: definition.unit, boundary: definition.boundary, measurementBasis: definition.basis, basis, origin: "automatic-local",
        status: "not-measured", value: null, reason: "missing-evidence", numerator: null, denominator: null,
        coverage: { covered: 0, eligible: eligibleUnitRefs.length }, counts: null, samples: [], pricing: null,
        eligibleUnitRefs, coveredUnitRefs: [], evidenceRefs: [], createdAt,
        observedTime: { state: "unavailable", firstAt: null, lastAt: null, datedUnits: 0, undatedUnits: eligibleUnitRefs.length },
    };
}
function durationMetric(state, basis, createdAt, definitionId, members, observations) {
    const metric = baseMetric(state, basis, createdAt, definitionId, "speed", members.map(m => m.ref));
    metric.samples = observations.filter(o => o.kind === "duration" && o.availability === "available" && o.payload.boundary === metric.boundary)
        .map(o => ({ unitRef: o.memberRef, value: o.payload.value, evidenceRefs: o.evidenceRefs }));
    metric.coveredUnitRefs = metric.samples.map(s => s.unitRef);
    metric.coverage.covered = metric.samples.length;
    metric.evidenceRefs = distinct(metric.samples.flatMap(s => s.evidenceRefs));
    const sorted = metric.samples.map(s => s.value).sort((a, b) => a - b);
    if (sorted.length) { metric.value = sorted[Math.ceil(sorted.length / 2) - 1]; metric.status = "measured"; metric.reason = null; }
    const dates = members.map(m => m.startedAt).filter(Boolean).sort();
    if (dates.length) metric.observedTime = { state: "available", firstAt: dates[0], lastAt: dates.at(-1), datedUnits: dates.length, undatedUnits: members.length - dates.length };
    return validateMetric(metric);
}
function pool(state, basis, createdAt, metrics) {
    const groups = new Map();
    for (const metric of metrics) {
        const key = metricSlotKey(metric);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(metric);
    }
    return [...groups].map(([key, values]) =>
        poolMetrics(values, assessmentRef(state, "metric", [key, values.flatMap(v => v.eligibleUnitRefs), basis]), createdAt));
}
function safeEndpoint(endpoint) {
    const normalized = normalizeEndpoint({ path: endpoint.pathTemplate, query: endpoint.queryKeys.map(key => ({ key })) },
        { method: endpoint.method, apiVersion: endpoint.apiVersion });
    return normalized.path === endpoint.pathTemplate && normalized.method === endpoint.method && normalized.apiVersion === endpoint.apiVersion
        && JSON.stringify(normalized.queryShape) === JSON.stringify(endpoint.queryKeys);
}
function returnedEntryPosition(row) {
    if (row.kind !== "returned-api-entry") return null;
    const [parent, position] = JSON.parse(row.id.slice("result:".length));
    if (parent !== row.parentCallId || !Number.isSafeInteger(position) || position < 0) throw new ContractError("invalid-canonical-result-identity");
    return position;
}
function attemptsForViews(views) {
    return views.filter(view => view.reviewStatus).map(view => ({
        interactionRef: view.interaction.interactionRef, latestAttempt: view.reviewStatus.assessment.latestAttempt,
    }));
}
function reviewStatusesForViews(views) {
    return views.filter(view => view.reviewStatus).map(view => ({
        interactionRef: view.interaction.interactionRef, reviewStatus: structuredClone(view.reviewStatus),
    }));
}
export function buildAssessmentModel(state, { records = state.evidence ?? [], source = state.personalEvaluation?.source ?? assessmentSource(state), createdAt = new Date().toISOString() } = {}) {
    const basis = assessmentBasis(state), consent = structuredClone(state.personalEvaluation?.consent ?? defaultConsent());
    validateConsent(consent);
    const claims = new Map(), conflictedCalls = new Set(), exclusions = new Map();
    const eligibleCall = (record, call) => ["copilot-app", "copilot-app-chat"].includes(record.sourceHost) && record.sourceSessionId
        && !record.sample && !record.synthetic && !call.synthetic && WORKIQ_TOOLS.includes(call.tool);
    for (const record of state.evidence ?? records) for (const call of record.toolCalls ?? []) if (eligibleCall(record, call) && call.startEventId && call.toolCallId) {
        const key = JSON.stringify([record.sourceSessionId, call.startEventId]);
        if (!claims.has(key)) claims.set(key, new Set());
        claims.get(key).add(JSON.stringify([record.sourceSessionId, call.toolCallId]));
    }
    for (const calls of claims.values()) if (calls.size > 1) for (const call of calls) conflictedCalls.add(call);
    const cleanRecords = records.map(record => {
        const counts = { raw: 0, conflicted: 0, unidentifiable: 0 };
        const toolCalls = (record.toolCalls ?? []).filter(call => {
            if (!eligibleCall(record, call)) return true;
            counts.raw++;
            if (!call.toolCallId && !call.startEventId) counts.unidentifiable++;
            if (conflictedCalls.has(JSON.stringify([record.sourceSessionId, call.toolCallId]))
                || claims.get(JSON.stringify([record.sourceSessionId, call.startEventId]))?.size > 1) { counts.conflicted++; return false; }
            return true;
        });
        exclusions.set(record.scenarioId, counts);
        return { ...record, toolCalls };
    });
    const selected = buildExportCatalog(cleanRecords), groups = new Map(), groupAliases = new Map();
    for (const record of selected.records) {
        const identity = JSON.stringify([record.sourceSessionId, record.userPrompt?.sourceEventId ?? record.scenarioId]);
        const prior = groups.get(identity);
        if (prior) {
            for (const field of ["toolCalls", "graphActivities", "httpRecords"]) prior[field].push(...(record[field] ?? []));
            if (record.assessmentMembershipPruned) prior.assessmentMembershipPruned = true;
        }
        else groups.set(identity, { ...record, toolCalls: [...(record.toolCalls ?? [])], graphActivities: [...(record.graphActivities ?? [])], httpRecords: [...(record.httpRecords ?? [])] });
        const owner = groups.get(identity).scenarioId;
        groupAliases.set(owner, distinct([...(groupAliases.get(owner) ?? []), ...(selected.requests.find(r => r.scenarioId === record.scenarioId)?.aliases ?? [record.scenarioId])]));
    }
    const canonicalRecords = [...groups.values()];
    const rows = [
        ["tool", "tool-call"], ["reported-api", "returned-api-entry"], ["http", "owned-http"],
        ["direct-request", "graph-request-site"], ["code-reference", "graph-code-reference"],
    ].flatMap(([layer, kind]) => buildActivityAnalytics(canonicalRecords, { layer, filters: { scope: "all", includeMetadata: true } }).rows.map(row => ({ ...row, kind })));
    const rowRefs = new Map(rows.map(row => [row.id, assessmentRef(state, "record", row.id)]));
    const details = new Map(), internals = new Map();
    const unitsByScenario = new Map(canonicalRecords.map(record => [record.scenarioId, recordUnits(record)]));
    for (const record of canonicalRecords) {
        const interactionRef = assessmentRef(state, "interaction", [record.sourceSessionId, record.userPrompt?.sourceEventId ?? record.scenarioId]);
        const members = [], observations = [], outcomes = [], patterns = [];
        const rawByRef = new Map();
        const ownRows = rows.filter(row => row.scenarioId === record.scenarioId);
        function observation(row, kind, payload, unavailableReason = null) {
            const member = members.find(m => m.ref === rowRefs.get(row.id));
            const evidenceRef = assessmentRef(state, "evidence", [row.id, kind, payload, unavailableReason]);
            const result = {
                schemaVersion: 1, interactionRef, basis, createdAt, evidenceRefs: [evidenceRef],
                observationRef: assessmentRef(state, "observation", [row.id, kind]), memberRef: member.ref,
                adapter: row.kind === "owned-http" ? "owned-graph-recorder-v1" : "copilot-local-events-v1",
                kind, origin: "retained-source", availability: unavailableReason ? "unavailable" : "available", reason: unavailableReason,
                occurredAt: member.startedAt, sourceEventRefs: [assessmentRef(state, "event", [record.sourceSessionId, row.id])],
                deletionKeys: member.deletionKeys, payload: unavailableReason ? null : payload, captureContext: null,
            };
            try { validateObservation(result); }
            catch (error) {
                if (!(error instanceof ContractError)) throw error;
                result.availability = "unavailable"; result.reason = "evaluator-failure"; result.payload = null;
                validateObservation(result);
            }
            observations.push(result);
            return result;
        }
        for (const row of ownRows) {
            const units = unitsByScenario.get(record.scenarioId);
            const raw = row.kind === "tool-call" || row.kind === "returned-api-entry"
                ? (record.toolCalls ?? []).find(c => row.toolCallId ? c.toolCallId === row.toolCallId
                    : `event:${JSON.stringify([record.sourceSessionId, c.startEventId])}` === (row.parentCallId ?? row.id))
                : row.kind === "owned-http" ? (record.httpRecords ?? []).find(r => r.recordId === row.recordId)
                    : (record.graphActivities ?? []).find(a => a.activityId === row.activityId);
            if (!raw) throw new ContractError("canonical-record-unavailable");
            const unit = units.find(unit => unit.item === raw);
            const ref = rowRefs.get(row.id), parentRef = row.kind === "returned-api-entry" ? rowRefs.get(row.parentCallId) : null;
            const deletionKeys = unit?.aliases ?? [];
            const identityBasis = row.kind === "tool-call" ? raw.toolCallId ? "source-and-call" : "source-and-start"
                : row.kind === "returned-api-entry" ? "parent-and-response-index" : row.kind === "owned-http" ? "owned-record-id" : "source-and-activity";
            members.push({
                ref, kind: row.kind, parentRef, responseIndex: returnedEntryPosition(row),
                identityBasis, aliases: [{ kind: row.kind === "tool-call" ? raw.toolCallId ? "call" : "start" : row.kind === "returned-api-entry" ? "response" : row.kind === "owned-http" ? "http" : "activity", keyHash: assessmentHash(row.id) }],
                deletionKeys, startedAt: recordedInstant(raw.startedAt),
            });
            rawByRef.set(ref, raw);
            if (row.kind === "tool-call") {
                observation(row, "tool-outcome", raw.completionEventId ? { completionRecorded: true, toolSucceeded: typeof raw.toolSucceeded === "boolean" ? raw.toolSucceeded : null, reportedOutcome: ["succeeded", "failed", "partial", "unknown"].includes(raw.reportedOutcome) ? raw.reportedOutcome : "unknown" }
                    : { completionRecorded: false, toolSucceeded: null, reportedOutcome: "unknown" });
                const start = recordedInstant(raw.startedAt), end = recordedInstant(raw.completedAt);
                if (start && end && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 && Date.parse(end) - Date.parse(start) === raw.durationMs) {
                    observation(row, "duration", { value: raw.durationMs, unit: "ms", boundary: "tool-start-to-completion", clock: "source-timestamps", startedAt: start, endedAt: end });
                }
            } else if (row.kind === "returned-api-entry") observation(row, "returned-status", { statusCode: validStatus(row.status) ? row.status : null, attribution: "response-array-position-not-target", index: members.at(-1).responseIndex });
            else if (row.kind === "owned-http") {
                observation(row, "http-status", { statusCode: validStatus(row.status) ? row.status : null, responseObserved: raw.observedGraphHttp === true, transportError: raw.transportError ?? null });
                if (recordedInstant(raw.startedAt) && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 && raw.durationBoundary === "request dispatch to response headers") {
                    observation(row, "duration", { value: raw.durationMs, unit: "ms", boundary: raw.transportError ? "http-dispatch-to-transport-error" : "http-dispatch-to-response-headers", clock: "monotonic", startedAt: recordedInstant(raw.startedAt), endedAt: null });
                }
            } else observation(row, "graph-status", { statusCode: validStatus(row.status) ? row.status : null, evidenceLevel: raw.evidenceLevel, requestCount: null });
            if (row.kind !== "graph-code-reference") {
                const outcomeBasis = row.kind === "tool-call" ? "recorded-tool-outcome" : row.kind === "returned-api-entry" ? validStatus(row.status) ? "numeric-returned-status" : row.outcome === "failure" ? "reported-symbolic-error" : "no-status"
                    : row.kind === "owned-http" ? raw.transportError ? "owned-transport-error" : validStatus(row.status) ? "owned-response" : "no-status" : validStatus(row.status) ? "output-visible-status" : "no-status";
                outcomes.push({ memberRef: ref, kind: row.kind, definitionVersion: 1, outcome: row.outcome, outcomeBasis, statusCode: row.kind === "tool-call" ? null : validStatus(row.status) ? row.status : null, evidenceRefs: [assessmentRef(state, "evidence", [row.id, "recorded-outcome"])] });
            }
            const endpoints = (row.targets?.length ? row.targets : row.endpoint?.path ? [row.endpoint] : []).filter(e => e.path && e.path !== "[endpoint unavailable]").slice(0, 100)
                .map(e => ({ pathTemplate: e.path, method: e.method ?? null, apiVersion: e.apiVersion ?? null, queryKeys: e.queryShape ?? [] }));
            const tool = row.kind === "owned-http" ? "owned-http" : row.tool;
            const display = { tool, workload: row.workload ?? "Unknown",
                attribution: row.kind === "returned-api-entry" ? "returned-entry-unattributed" : row.kind === "owned-http" ? "owned-request" : row.kind.includes("graph") ? "recorded-site"
                    : row.workload === "Discovery" ? tool === "workiq-get_schema" ? "schema-reference" : "discovery"
                        : endpoints.length > 1 ? "requested-batch-targets" : endpoints.length ? "requested-single-target" : "unavailable", endpoints };
            const structural = { unitKind: row.kind, toolClass: tool.startsWith("workiq-") ? "workiq" : tool,
                method: row.endpoint?.method ?? null, apiVersion: row.endpoint?.apiVersion ?? null, targetShape: endpoints.length > 1 ? "multiple" : endpoints.length ? "single" : "unavailable", display };
            patterns.push({ pattern: { version: 3, normalizer: "wire-safe-technical-pattern-v3", key: assessmentHash(structural), ...structural }, memberRefs: [ref] });
        }
        const aliases = groupAliases.get(record.scenarioId);
        const excluded = aliases.reduce((sum, id) => {
            const item = exclusions.get(id);
            for (const key of ["raw", "conflicted", "unidentifiable"]) sum[key] += item?.[key] ?? 0;
            return sum;
        }, { raw: 0, conflicted: 0, unidentifiable: 0 });
        const duplicate = excluded.raw - excluded.conflicted - excluded.unidentifiable - members.filter(m => m.kind === "tool-call").length;
        if (duplicate < 0) throw new ContractError("inconsistent-canonical-membership");
        const interaction = {
            schemaVersion: 1, interactionRef, sourceRef: assessmentRef(state, "source", record.sourceSessionId), sourceAdapter: "copilot-local-events-v1",
            sourceGroupRefs: aliases.map(id => assessmentRef(state, "group", id)),
            sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, basis,
            capturedAt: recordedInstant(record.capturedAt), retained: true,
            membershipStatus: excluded.conflicted || excluded.unidentifiable ? "unverified" : record.assessmentMembershipPruned ? "partial" : "complete-retained",
            pruned: record.assessmentMembershipPruned === true,
            excluded: { duplicate, unidentifiable: excluded.unidentifiable, conflicted: excluded.conflicted, synthetic: 0 },
            message: { eventRef: record.userPrompt?.sourceEventId ? assessmentRef(state, "event", [record.sourceSessionId, record.userPrompt.sourceEventId]) : null,
                origin: promptAuthorship.read(record.userPrompt).actor === "unknown" ? "recorded-unverified" : promptAuthorship.read(record.userPrompt).actor,
                authorship: promptAuthorship.read(record.userPrompt),
                association: record.userPrompt?.sourceEventId ? "nearest-preceding" : "unverified",
                completeness: ["full", "partial", "unavailable"].includes(record.userPrompt?.status) ? record.userPrompt.status : "unavailable",
                recordedAt: recordedInstant(record.userPrompt?.sourceTimestamp) }, members,
        };
        const currentRefs = new Set(members.map(m => m.ref)), removed = new Set(state.deletion?.identities ?? []);
        const captures = (state.personalEvaluation?.captures ?? []).filter(c => c.observation.interactionRef === interactionRef
            && c.dependencies.recordRefs.length === currentRefs.size && c.dependencies.recordRefs.every(ref => currentRefs.has(ref)) && !c.dependencies.deletionKeys.some(key => removed.has(key))
            && consent.state === "enabled" && c.observation.captureContext?.consentRevision === consent.revision
            && c.observation.captureContext?.sourceConfigRef === source.sourceConfigRef && c.observation.captureContext?.sourceConfigRevision === source.sourceConfigRevision);
        for (const capture of captures) observations.push({ ...structuredClone(capture.observation), basis });
        const assessments = [];
        const metrics = [];
        metrics.push(durationMetric(state, basis, createdAt, "tool-duration", members.filter(m => m.kind === "tool-call"), observations));
        for (const definition of ["http-response-duration", "http-error-duration"]) {
            const http = members.filter(m => m.kind === "owned-http" && Boolean(rawByRef.get(m.ref).transportError) === (definition === "http-error-duration"));
            if (http.length) metrics.push(durationMetric(state, basis, createdAt, definition, http, observations));
        }
        const responseTime = baseMetric(state, basis, createdAt, "recorded-response-duration", "speed", [interactionRef]);
        const timing = record.responseTiming;
        if (!record.assessmentMembershipPruned && timing?.schemaVersion === 1 && timing.status === "measured" && timing.boundary === responseTime.boundary
            && timing.promptEventId === record.userPrompt?.sourceEventId
            && timing.requestedAt === record.userPrompt?.sourceTimestamp
            && recordedInstant(timing.requestedAt) && recordedInstant(timing.respondedAt) && recordedInstant(timing.completedAt)
            && Date.parse(timing.completedAt) >= Date.parse(timing.respondedAt)
            && Number.isFinite(timing.durationMs) && timing.durationMs >= 0
            && Date.parse(timing.respondedAt) - Date.parse(timing.requestedAt) === timing.durationMs
            && typeof timing.finalEventId === "string" && typeof timing.completionEventId === "string"
            && ["explicit-message-link", "single-recorded-message-interval"].includes(timing.association)) {
            const evidenceRef = assessmentRef(state, "evidence", [record.sourceSessionId, timing]);
            Object.assign(responseTime, {
                status: "measured", value: timing.durationMs, reason: null,
                coverage: { covered: 1, eligible: 1 }, coveredUnitRefs: [interactionRef], evidenceRefs: [evidenceRef],
                samples: [{ unitRef: interactionRef, value: timing.durationMs, evidenceRefs: [evidenceRef] }],
            });
        }
        metrics.push(validateMetric(responseTime));
        const view = { schemaVersion: 1, basis, interaction, consent, observations, assessments, metrics };
        validateInteractionView(view);
        details.set(interactionRef, view);
        internals.set(interactionRef, { record, sourceGroupIds: aliases, outcomes, patterns });
    }
    const catalog = records.map(record => {
        const refs = distinct([...internals].filter(([, value]) => value.sourceGroupIds.includes(record.scenarioId)).map(([ref]) => ref));
        const view = refs.length === 1 ? details.get(refs[0]) : null;
        const samePrompt = record.userPrompt?.sourceEventId && view?.interaction.message.eventRef
            === assessmentRef(state, "event", [record.sourceSessionId, record.userPrompt.sourceEventId])
            && view.interaction.message.recordedAt === recordedInstant(record.userPrompt.sourceTimestamp);
        const responseTime = samePrompt ? view.metrics.find(metric => metric.definitionId === "recorded-response-duration") : null;
        return { scenarioId: record.scenarioId, interactionRef: refs.length === 1 ? refs[0] : null, interactionRefs: refs,
            status: refs.length === 1 ? "retained" : refs.length ? "unverified" : "excluded",
            reason: refs.length === 1 ? null : refs.length || exclusions.get(record.scenarioId)?.conflicted ? "conflicting-membership" : "no-eligible-retained-evidence",
            responseTiming: {
                schemaVersion: 1, sourceRevision: basis.sourceRevision, interactionRef: view?.interaction.interactionRef ?? null,
                boundary: DEFINITIONS["recorded-response-duration"].boundary,
                status: responseTime?.status === "measured" ? "measured" : "unavailable",
                durationMs: responseTime?.status === "measured" ? responseTime.value : null,
            },
            ...(refs.length === 1 && details.get(refs[0])?.reviewStatus
                ? { reviewStatusRevision: assessmentHash(details.get(refs[0]).reviewStatus) } : {}) };
    });
    return { schemaVersion: 1, basis, details, internals, catalog, consent, source, capabilities,
        overview: { interactionRefs: [...details.keys()], metrics: pool(state, basis, createdAt, [...details.values()].flatMap(view => view.metrics)),
            assessmentAttempts: attemptsForViews([...details.values()]), reviewStatuses: reviewStatusesForViews([...details.values()]) } };
}
export function cachedAssessmentModel(state, source) {
    const evaluation = state.personalEvaluation?.modelEvaluation;
    const attempts = evaluation?.runs.map(run => [run.runRef, run.phase, run.results.map(result => [result.interactionRef, result.status])]);
    const key = JSON.stringify([state.pseudonymKey, state.evidenceFile, assessmentBasis(state), source,
        attempts, evaluation?.automatic?.approval?.revision, evaluation?.automatic?.approval?.state]);
    if (!caches.has(key)) {
        if (caches.size >= 8) caches.delete(caches.keys().next().value);
        caches.set(key, buildAssessmentModel(state, { source }));
    }
    return caches.get(key);
}
export function assessmentOverview(state, model, interactionRefs) {
    if (new Set(interactionRefs).size !== interactionRefs.length || interactionRefs.some(ref => !model.details.has(ref))) throw new ContractError("stale-membership");
    return { interactionRefs: [...interactionRefs], metrics: pool(state, model.basis, new Date().toISOString(), interactionRefs.flatMap(ref => model.details.get(ref).metrics)),
        assessmentAttempts: attemptsForViews(interactionRefs.map(ref => model.details.get(ref))),
        reviewStatuses: reviewStatusesForViews(interactionRefs.map(ref => model.details.get(ref))) };
}
export function assessmentDependencies(view) {
    return {
        interactionRefs: [view.interaction.interactionRef], recordRefs: view.interaction.members.map(m => m.ref),
        evidenceRefs: distinct(view.observations.flatMap(o => o.evidenceRefs)),
        deletionKeys: distinct(view.interaction.members.flatMap(m => m.deletionKeys)), basis: { ...view.basis },
    };
}
export function assertReportCurrent(dependencies, currentState, { sourceContentVerified = false } = {}) {
    if (currentState.deletion?.pending && currentState.deletion.operations?.[currentState.deletion.pending]?.kind !== "artifact-deletion") throw new ContractError("deletion-pending");
    const basis = assessmentBasis(currentState);
    if (typeof sourceContentVerified !== "boolean") throw new ContractError("invalid-source-proof");
    for (const key of BASIS_KEYS) {
        if (sourceContentVerified && ["sourceRevision", "membershipRevision"].includes(key)) continue;
        if (basis[key] !== dependencies.basis[key]) throw new ContractError(`stale-${key}`);
    }
    const removed = new Set(currentState.deletion?.identities ?? []);
    if (dependencies.deletionKeys.some(key => removed.has(key))) throw new ContractError("deleted-dependency");
    if (sourceContentVerified) {
        const model = cachedAssessmentModel(currentState);
        const wanted = new Set(dependencies.recordRefs), actualRecords = new Set(), actualEvidence = new Set();
        for (const ref of dependencies.interactionRefs) {
            const view = model.details.get(ref);
            if (!view) throw new ContractError("stale-membership");
            for (const member of view.interaction.members) if (wanted.has(member.ref)) actualRecords.add(member.ref);
            for (const observation of view.observations) if (observation.memberRef === null || wanted.has(observation.memberRef)) {
                observation.evidenceRefs.forEach(ref => actualEvidence.add(ref));
            }
        }
        if (actualRecords.size !== wanted.size || actualEvidence.size !== dependencies.evidenceRefs.length
            || !dependencies.evidenceRefs.every(ref => actualEvidence.has(ref))) throw new ContractError("stale-assessment-evidence");
    }
    return true;
}
export function buildReportFacts(selectedCanonicalRecords, currentState, { preparedAt = new Date().toISOString(), scope = {}, source, interactionOrder } = {}) {
    const model = buildAssessmentModel(currentState, { records: selectedCanonicalRecords, createdAt: preparedAt, source });
    if (interactionOrder !== undefined && (!Array.isArray(interactionOrder)
        || interactionOrder.length !== model.details.size || new Set(interactionOrder).size !== interactionOrder.length
        || Array.from(interactionOrder).some(ref => typeof ref !== "string" || !model.details.has(ref)))) {
        throw new ContractError("invalid-report-interaction-order");
    }
    // Preserve canonical deduplication, then pool in the accepted consumer order.
    const views = interactionOrder === undefined ? [...model.details.values()] : interactionOrder.map(ref => model.details.get(ref));
    const overview = interactionOrder === undefined ? model.overview : {
        interactionRefs: [...interactionOrder],
        metrics: pool(currentState, model.basis, preparedAt, views.flatMap(view => view.metrics)),
        assessmentAttempts: attemptsForViews(views), reviewStatuses: reviewStatusesForViews(views),
    };
    const dependencies = {
        interactionRefs: overview.interactionRefs, recordRefs: views.flatMap(v => v.interaction.members.map(m => m.ref)),
        evidenceRefs: distinct(views.flatMap(v => v.observations.flatMap(o => o.evidenceRefs))),
        deletionKeys: distinct(views.flatMap(v => v.interaction.members.flatMap(m => m.deletionKeys))), basis: model.basis,
    };
    const metrics = structuredClone(overview.metrics);
    for (const metric of metrics) if (metric.observedTime.state === "available") metric.observedTime = { ...metric.observedTime, state: "withheld", firstAt: null, lastAt: null };
    const patterns = new Map();
    for (const item of [...model.internals.values()].flatMap(v => v.patterns)) {
        if (!patterns.has(item.pattern.key)) patterns.set(item.pattern.key, { pattern: item.pattern, memberRefs: [] });
        patterns.get(item.pattern.key).memberRefs.push(...item.memberRefs);
    }
    const serviceRows = buildActivityAnalytics([...model.internals.values()].map(value => value.record), {
        layer: "tool", filters: { scope: "all", includeMetadata: true },
    });
    const memberRef = rowId => assessmentRef(currentState, "record", rowId);
    const serviceInvolvement = {
        definition: serviceRows.serviceInvolvement.definition, layer: "tool-call",
        memberRefs: serviceRows.rows.map(row => memberRef(row.id)), denominator: serviceRows.totals.count,
        groups: serviceRows.serviceInvolvement.groups.map(group => ({
            service: group.label, memberRefs: group.drilldownIds.map(memberRef), count: group.total,
        })),
        missingDetailRefs: serviceRows.rows.filter(row => row.serviceAssociation.gaps.length).map(row => memberRef(row.id)),
        notApplicableRefs: serviceRows.rows.filter(row => row.serviceAssociation.status === "not-applicable").map(row => memberRef(row.id)),
    };
    const facts = {
        schemaVersion: 1, contractVersion: "WIRE-PERSONAL-EVAL-v1",
        metricProjectionVersion: METRIC_PROJECTION_VERSION,
        snapshotRef: assessmentRef(currentState, "snapshot", [preparedAt, dependencies]), preparedAt,
        namespace: { ref: assessmentRef(currentState, "namespace", "report-v1"), version: 1, identityScheme: "keyed-report-pseudonyms-v1" },
        basis: model.basis, scope: { kind: scope.kind ?? "selected", membership: model.catalog.some(row => row.status !== "retained") || views.some(v => v.interaction.membershipStatus !== "complete-retained") ? "partial-retained" : "exact-retained",
            from: scope.from ?? null, untilExclusive: scope.untilExclusive ?? null, timeZone: scope.timeZone ?? "UTC" },
        memberships: views.map(v => ({ interactionRef: v.interaction.interactionRef, membershipRevision: v.basis.membershipRevision, status: v.interaction.membershipStatus,
            members: v.interaction.members.map(({ ref, kind }) => ({ ref, kind })) })),
        metrics, assessments: views.flatMap(v => v.assessments), recordedOutcomes: [...model.internals.values()].flatMap(v => v.outcomes),
        serviceInvolvement,
        patterns: [...patterns.values()], privacyProjectionVersion: 1,
    };
    return { facts: freezeReportFacts(facts, { validateEndpoint: safeEndpoint }), dependencies };
}
export const evaluationAdapter = Object.freeze({ buildReportFacts, assertReportCurrent });
