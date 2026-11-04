import { open, lstat } from "node:fs/promises";
import path from "node:path";
import { hash, contextFits, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { retainEvent } from "./collector.mjs";
import { completeWorkIqCall } from "./history.mjs";
import { normalizeResultEvidence } from "./result-evidence.mjs";
import { projectReportResultObservation, validateReportResultFacts, RESULT_FACT_DEFINITION } from "./report-result-facts.mjs";
import { filterDeletedEvents, eventIdentity, callIdentity } from "./deletion-identities.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { resolveDataDir } from "./store.mjs";
import { buildAssessmentModel, assessmentSource, assessmentRef } from "./assessment-read-model.mjs";
import { runMetadataMaintenance, validateMaintenancePlan, maintenanceMetadata } from "./historical-maintenance.mjs";

const { digest, sha, id, instant, requireThat, same, shape } = maintenanceMetadata;
const omitted = Object.freeze({ version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "size-excluded", messageSignal: null });
const absentResult = Object.freeze({ version: 1, source: "sdk-result", applicationError: null,
    statusCode: null, contentStatus: "not-supplied", resultCount: null });

export function requireMatchedReaders() {
    const partial = { ...absentResult, contentStatus: "partial" };
    same(normalizeResultEvidence(partial), partial, "The pinned retained reader does not support partial evidence. Do not use an older runtime.");
    // Exercise the actual frozen-fact reader as well; unchanged version labels are not compatibility evidence.
    const observation = projectReportResultObservation("result-observation-" + "0".repeat(32),
        { resultEvidence: partial, retainedResultCount: 0, returnedEntries: [] });
    const facts = { version: 1, definition: RESULT_FACT_DEFINITION, namespace: "namespace-" + "0".repeat(32),
        calls: [{ ref: "record-" + "0".repeat(32), source: "github-copilot", tool: "workiq-fetch",
            completion: "failed", observations: [observation] }] };
    same(validateReportResultFacts(facts), facts, "The pinned report reader does not support partial evidence. Do not use an older runtime.");
    requireThat(observation.contentStatus === "partial" && observation.resultCount === null,
        "The pinned report projection cannot preserve partial evidence with unknown totals.");
}

function validatePlan(plan, diagnosticOnly, recordOnly) {
    validateMaintenancePlan(plan);
    requireThat(Array.isArray(plan.targets) && plan.targets.length === 1, "Failure-evidence maintenance requires exactly one existing call.");
    const target = plan.targets[0];
    shape(target, ["scenarioId", "sourceSessionId", "interactionRef", "recordSha256", "prompt", "call", "sourceEvent",
        recordOnly ? "checkpointContextSha256" : "checkpointEventSha256"]);
    requireThat(id(target.scenarioId) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.sourceSessionId)
        && /^interaction-[a-f0-9]{32}$/.test(target.interactionRef) && sha(target.recordSha256)
        && sha(recordOnly ? target.checkpointContextSha256 : target.checkpointEventSha256), "Invalid exact failure-evidence target.");
    shape(target.prompt, ["sourceEventId", "sourceTimestamp", "textSha256"]);
    requireThat(id(target.prompt.sourceEventId) && instant(target.prompt.sourceTimestamp) && sha(target.prompt.textSha256), "Invalid retained prompt binding.");
    shape(target.call, ["tool", "toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"]);
    const call = target.call;
    requireThat(call.tool === (diagnosticOnly ? "workiq-retrieve" : "workiq-fetch")
        && [call.toolCallId, call.startEventId, call.completionEventId].every(id)
        && instant(call.startedAt) && instant(call.completedAt) && Date.parse(call.startedAt) >= Date.parse(target.prompt.sourceTimestamp)
        && Date.parse(call.completedAt) >= Date.parse(call.startedAt), "Invalid exact failed-call binding for this restoration variant.");
    shape(target.sourceEvent, ["offset", "bytes", "sha256", "startupBytes", "startupSha256"]);
    const source = target.sourceEvent;
    requireThat(Number.isSafeInteger(source.startupBytes) && source.startupBytes > 0 && source.startupBytes <= 65536
        && Number.isSafeInteger(source.offset) && source.offset >= source.startupBytes
        && Number.isSafeInteger(source.bytes) && source.bytes > 0 && source.bytes <= TAIL_LIMITS.maxLineBytes
        && Number.isSafeInteger(source.offset + source.bytes) && sha(source.sha256) && sha(source.startupSha256), "Invalid bounded source byte binding.");
}

function requireOmission(failure, result, entries, diagnosticOnly) {
    const { diagnostic, ...flags } = failure ?? {};
    same(flags, diagnosticOnly ? { ...omitted, messageStatus: "text-excluded" } : omitted,
        "The target does not have the expected error omission for this variant.");
    if (diagnosticOnly) requireThat(diagnostic === undefined, "Existing diagnostic evidence must not be overwritten.");
    else if (diagnostic !== undefined) same(diagnostic, { version: 1, source: "completion-error", status: "size-excluded", code: "failure" },
        "Existing diagnostic evidence must not be overwritten.");
    if (result != null) {
        same(normalizeResultEvidence(result), absentResult, "Existing result evidence must not be overwritten.");
        same(result, absentResult, "Unsupported existing result fields must not be discarded.");
    }
    requireThat(Array.isArray(entries) && entries.length === 0, "Existing returned entries must not be overwritten.");
}

export function validateUnassessed(state, plan, config, records) {
    const target = plan.targets[0], source = assessmentSource(state, config);
    const model = buildAssessmentModel(state, { records, source });
    const mapping = model.catalog.find(item => item.scenarioId === target.scenarioId);
    requireThat(mapping?.status === "retained" && mapping.interactionRef === target.interactionRef
        && model.internals.get(target.interactionRef)?.sourceGroupIds.length === 1, "Failure target canonical interaction is missing or ambiguous.");
    requireThat(records.filter(record => record.scenarioId === target.scenarioId && record.sourceSessionId === target.sourceSessionId).length === 1,
        "Failure target source binding changed.");
    const data = state.personalEvaluation?.modelEvaluation;
    requireThat(!data?.records.some(item => item.interactionRef === target.interactionRef)
        && !data?.runs.some(run => [...run.scope, ...run.results].some(item => item.interactionRef === target.interactionRef))
        && !data?.grants.some(grant => grant.interactionRefs.includes(target.interactionRef)), "Failure target is scored, attempted or enrolled.");
    const approval = data?.automatic?.approval;
    requireThat(!(approval?.state === "enabled" && approval.sourceConfigRef === source.sourceConfigRef
        && approval.sourceConfigRevision === source.sourceConfigRevision
        && approval.chatRefs.includes(assessmentRef(state, "chat", target.sourceSessionId))
        && (!approval.interactionRefs || approval.interactionRefs.includes(target.interactionRef))), "Failure target is inside the automatic-scoring scope.");
}

// Seek only the two sealed JSONL regions. Never discover targets, scan history, or follow payload pointers.
export async function readBoundFailureCompletion(config, target, { consumedCursor, tailRetrieve = false } = {}) {
    const file = await safeDeletionFile(config.sessionRoot, path.join(target.sourceSessionId, "events.jsonl"));
    const handle = await open(file, "r");
    try {
        const before = await handle.stat(), source = target.sourceEvent;
        requireThat(before.isFile() && before.nlink === 1 && source.offset + source.bytes <= before.size, "Bound source file is missing, linked or incomplete.");
        async function region(offset, length, expected) {
            const bytes = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
                const next = await handle.read(bytes, read, length - read, offset + read);
                requireThat(next.bytesRead > 0, "Bound source region became incomplete.");
                read += next.bytesRead;
            }
            requireThat(hash(bytes) === expected && bytes.at(-1) === 10 && bytes.indexOf(10) === bytes.length - 1,
                "Bound source region changed or is not one complete JSONL entry.");
            let value;
            try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
            catch (error) {
                if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
                requireThat(false, "Bound source entry is not readable UTF-8 JSON.");
            }
            return value;
        }
        const startup = await region(0, source.startupBytes, source.startupSha256);
        requireThat(startup?.type === "session.start" && id(startup.id) && instant(startup.timestamp)
            && startup.data?.version === 1 && startup.data.sessionId === target.sourceSessionId,
            "Bound source session identity changed.");
        if (consumedCursor) {
            const qualifiedPrefix = tailRetrieve
                ? Number.isSafeInteger(consumedCursor.droppedBytes) && consumedCursor.droppedBytes >= source.startupBytes
                    && source.offset >= consumedCursor.droppedBytes
                : consumedCursor.droppedBytes === 0;
            requireThat(consumedCursor.identity === `${before.dev}:${before.ino}:${before.birthtimeMs}:${startup.id}`
                && Number.isSafeInteger(consumedCursor.offset) && consumedCursor.offset >= source.offset + source.bytes
                && consumedCursor.offset <= before.size && qualifiedPrefix,
            "The aged-out target is not qualified within this consumed source generation.");
        }
        const boundary = Buffer.alloc(1);
        requireThat((await handle.read(boundary, 0, 1, source.offset - 1)).bytesRead === 1 && boundary[0] === 10,
            "Bound completion does not start at a JSONL boundary.");
        const event = await region(source.offset, source.bytes, source.sha256), call = target.call;
        requireThat(event?.id === call.completionEventId && event.type === "tool.execution_complete"
            && event.timestamp === call.completedAt && event.data?.toolCallId === call.toolCallId && event.data.success === false
            && event.data.result == null && event.data.error?.code === "failure"
            && typeof event.data.error.message === "string",
        "Bound source completion identity, outcome or error shape changed.");
        requireThat(sourceFileStamp(await handle.stat()) === sourceFileStamp(before), "Bound source file changed during the exact read.");
        return event;
    } finally { await handle.close(); }
}

async function readProjection(config, target, diagnosticOnly, consumedCursor, tailRetrieve) {
    const event = await readBoundFailureCompletion(config, target, { consumedCursor, tailRetrieve });
    const call = target.call, messageBytes = Buffer.byteLength(event.data.error.message);
    requireThat(diagnosticOnly ? messageBytes > 0 && messageBytes <= 8192 : messageBytes > 8192,
        "Bound source error size does not match this restoration variant.");
    const retained = JSON.parse(JSON.stringify(retainEvent(event, { credentialExclusions: 0 })));
    const projected = completeWorkIqCall({ startedAt: call.startedAt }, retained);
    if (diagnosticOnly) {
        const { diagnostic, ...flags } = projected.failureEvidence ?? {};
        same(flags, { ...omitted, messageStatus: "text-excluded" }, "Bound source error has a different qualified failure shape.");
        shape(diagnostic, ["version", "source", "status", "code", "message"]);
        requireThat(diagnostic.version === 1 && diagnostic.source === "completion-error" && diagnostic.code === "failure"
            && ["recorded", "redacted"].includes(diagnostic.status) && typeof diagnostic.message === "string"
            && diagnostic.message.trim() && diagnostic.message.trim().toLowerCase() !== "failure"
            && projected.apiResults.length === 0, "The bound completion supplies no supported literal diagnostic restoration.");
    } else {
        requireThat(projected.resultEvidence?.contentStatus === "partial" && projected.resultEvidence.resultCount === null
            && projected.apiResults.some(entry => entry.errorDiagnostic?.message), "The bound completion supplies no supported partial returned-error repair.");
    }
    if (diagnosticOnly) return { diagnostic: projected.failureEvidence.diagnostic };
    return { failureEvidence: projected.failureEvidence, resultEvidence: projected.resultEvidence, apiResults: projected.apiResults,
        retainedEntries: retained.data.result.structuredContent.results };
}

export function runFailureEvidenceMaintenance(options, hooks) {
    return runExactFailureMaintenance(options, hooks, "fetch");
}

export function runRetrieveDiagnosticMaintenance(options, hooks) {
    return runExactFailureMaintenance(options, hooks, "retrieve");
}

export function runEvictedFetchEvidenceMaintenance(options, hooks) {
    return runExactFailureMaintenance(options, hooks, "evicted-fetch");
}

export function runTailRetrieveDiagnosticMaintenance(options, hooks) {
    return runExactFailureMaintenance(options, hooks, "tail-retrieve");
}

function runExactFailureMaintenance(options, hooks, variant) {
    const tailRetrieve = variant === "tail-retrieve";
    const diagnosticOnly = variant === "retrieve" || tailRetrieve, recordOnly = variant === "evicted-fetch" || tailRetrieve;
    let projection, contextCalls, contextEvents;
    const policy = {
        validatePlan: plan => validatePlan(plan, diagnosticOnly, recordOnly),
        async validateState(state, plan, config, records, index) {
            requireMatchedReaders();
            validateUnassessed(state, plan, config, records);
            const target = plan.targets[0];
            const checkpoint = await safeDeletionFile(resolveDataDir({ dataDir: options.dataDir }),
                path.join("collector", digest([config.appDbPath, config.sessionRoot, config.windowDays]), `${target.sourceSessionId}.json`));
            requireThat((await lstat(checkpoint)).isFile(), "The existing target checkpoint is required; none is reconstructed.");
            if (recordOnly) {
                const retained = records.find(record => record.scenarioId === target.scenarioId);
                contextCalls = new Set(retained.toolCalls.map(call => call.toolCallId).filter(Boolean));
                contextEvents = new Set(retained.toolCalls.flatMap(call => [call.startEventId, call.completionEventId]).filter(Boolean));
                const deletedEvents = new Set(state.deletion?.events ?? []);
                const deletedCalls = new Set([...(state.deletion?.identities ?? []), ...(state.deletion?.contextCalls ?? [])]);
                requireThat(![target.prompt.sourceEventId, target.call.startEventId, target.call.completionEventId]
                    .some(id => deletedEvents.has(eventIdentity(target.sourceSessionId, id)))
                    && !deletedCalls.has(callIdentity(target.sourceSessionId, target.call.toolCallId)),
                "The aged-out target has a deletion conflict; no evidence is restored.");
                const source = index.sources[target.sourceSessionId];
                requireThat(source?.scanned === true && !source.error
                    && index.sources[target.sourceSessionId].cursor && typeof index.sources[target.sourceSessionId].cursor === "object"
                    && index.sources[target.sourceSessionId].cursor.backlogBytes === 0
                    && index.sources[target.sourceSessionId].cursor.partialBytes === 0
                    && index.sources[target.sourceSessionId].cursor.skipping === false
                    && source.backfillPending !== true
                    && (tailRetrieve ? source.backfill?.phase === "visited"
                        && source.backfill.omittedBytes === source.cursor.droppedBytes
                        && typeof source.backfill.boundaryGap === "boolean"
                        && source.cursor.logBytes === source.cursor.offset
                        : source.backfill === undefined),
                    "The aged-out target requires an intact consumed-source index.");
            }
            projection = await readProjection(config, target, diagnosticOnly,
                recordOnly ? index.sources[target.sourceSessionId].cursor : undefined, tailRetrieve);
        },
        projectRecords(records, plan) {
            const target = plan.targets[0], call = target.call;
            requireThat(records.filter(record => record.scenarioId === target.scenarioId).length === 1
                && records.filter(record => record.sourceSessionId === target.sourceSessionId && record.userPrompt?.sourceEventId === target.prompt.sourceEventId).length === 1
                && records.flatMap(record => record.sourceSessionId === target.sourceSessionId ? record.toolCalls ?? [] : [])
                    .filter(value => value.toolCallId === call.toolCallId || value.startEventId === call.startEventId || value.completionEventId === call.completionEventId).length === 1,
            "Failure target is missing or ambiguous.");
            return records.map(record => {
                if (record.scenarioId !== target.scenarioId) return record;
                requireThat(digest(record) === target.recordSha256 && record.sourceSessionId === target.sourceSessionId, "Failure record preimage changed.");
                requireThat(record.userPrompt?.status === "full" && record.userPrompt.sourceEventId === target.prompt.sourceEventId
                    && record.userPrompt.sourceTimestamp === target.prompt.sourceTimestamp && typeof record.userPrompt.text === "string"
                    && hash(record.userPrompt.text) === target.prompt.textSha256, "Failure prompt binding changed.");
                return { ...record, toolCalls: record.toolCalls.map(value => {
                    if (value.toolCallId !== call.toolCallId) return value;
                    for (const key of Object.keys(call)) same(value[key], call[key], "Failed-call identity or timing changed.");
                    requireThat(value.toolSucceeded === false && value.reportedOutcome === "failed", "The target is not a recorded failed call.");
                    requireOmission(value.failureEvidence, value.resultEvidence, value.apiResults, diagnosticOnly);
                    if (diagnosticOnly) return { ...value, failureEvidence: { ...value.failureEvidence, diagnostic: projection.diagnostic } };
                    const { retainedEntries, ...fields } = projection;
                    return { ...value, ...fields };
                }) };
            });
        },
        projectCheckpoint(checkpoint, source, plan, state, index, { allowPostimage }) {
            const target = plan.targets[0], call = target.call;
            requireThat(source === target.sourceSessionId && checkpoint.schemaVersion === 1 && Array.isArray(checkpoint.events), "Invalid existing target checkpoint.");
            same(checkpoint.cursor, index.sources[source]?.cursor, "Checkpoint cursor and approved index disagree.");
            if (recordOnly) {
                requireThat(digest(checkpoint) === target.checkpointContextSha256 && contextFits(checkpoint.events),
                    "The reviewed aged-out context changed or exceeds its bounds.");
                const references = checkpoint.events.filter(event => contextEvents.has(event.id)
                    || contextCalls.has(event.data?.toolCallId) || contextCalls.has(event.data?.parentToolCallId)
                    || event.data?.wireToolRequestIds?.some(id => contextCalls.has(id)));
                requireThat(references.length === 0, "The interaction's call context is partially present or ambiguous, not wholly aged out.");
                const prompts = checkpoint.events.filter(event => event.id === target.prompt.sourceEventId);
                requireThat(prompts.length === 1 && prompts[0].type === "user.message"
                    && prompts[0].timestamp === target.prompt.sourceTimestamp && typeof prompts[0].data?.content === "string"
                    && hash(prompts[0].data.content) === target.prompt.textSha256,
                "The original retained prompt boundary is missing or conflicting.");
                same(filterDeletedEvents(checkpoint.events, source, state.deletion), checkpoint.events,
                    "Deletion filtering would change the reviewed aged-out context.");
                return checkpoint;
            }
            const matches = checkpoint.events.filter(event => event.id === call.completionEventId
                || event.type === "tool.execution_complete" && event.data?.toolCallId === call.toolCallId);
            requireThat(matches.length === 1, "The exact existing completion is missing or ambiguous; none is reconstructed.");
            const event = matches[0];
            requireThat(event.id === call.completionEventId && event.type === "tool.execution_complete"
                && event.timestamp === call.completedAt && event.data?.toolCallId === call.toolCallId && event.data.success === false,
            "Retained completion identity or outcome changed.");
            if (allowPostimage) {
                if (diagnosticOnly) {
                    same(event.data.wireFailureEvidence, { ...omitted, messageStatus: "text-excluded", diagnostic: projection.diagnostic },
                        "Retained diagnostic postimage changed.");
                    return checkpoint;
                }
                same(event.data.wireFailureEvidence, projection.failureEvidence, "Retained failure postimage changed.");
                same(event.data.wireResultEvidence, projection.resultEvidence, "Retained result postimage changed.");
                same(event.data.result?.structuredContent?.results, projection.retainedEntries, "Retained entries postimage changed.");
                return checkpoint;
            }
            requireThat(digest(event) === target.checkpointEventSha256, "Retained completion preimage changed.");
            requireOmission(event.data.wireFailureEvidence, event.data.wireResultEvidence, event.data.result?.structuredContent?.results, diagnosticOnly);
            const next = structuredClone(checkpoint), updated = next.events[checkpoint.events.indexOf(event)];
            if (diagnosticOnly) updated.data.wireFailureEvidence.diagnostic = projection.diagnostic;
            else {
                updated.data.wireFailureEvidence = projection.failureEvidence;
                updated.data.wireResultEvidence = projection.resultEvidence;
                updated.data.result.structuredContent.results = projection.retainedEntries;
            }
            requireThat(contextFits(next.events), "Failure postimage exceeds checkpoint bounds; no context is evicted.");
            same(filterDeletedEvents(next.events, source, state.deletion), next.events, "Deletion filtering would change the target checkpoint.");
            return next;
        },
    };
    return runMetadataMaintenance(options, policy, hooks);
}
