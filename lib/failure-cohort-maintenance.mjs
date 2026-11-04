import { lstat } from "node:fs/promises";
import path from "node:path";
import { retainEvent } from "./collector.mjs";
import { completeWorkIqCall } from "./history.mjs";
import { retainedErrorDiagnostic } from "./failure-details.mjs";
import { contextFits, hash as digestText } from "./collector-io.mjs";
import { filterDeletedEvents, eventIdentity, callIdentity } from "./deletion-identities.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { readBoundFailureCompletion, requireMatchedReaders, validateUnassessed } from "./failure-evidence-maintenance.mjs";
import { runMetadataMaintenance, validateMaintenancePlan, maintenanceMetadata } from "./historical-maintenance.mjs";

const { digest, sha, id, instant, requireThat, same, shape } = maintenanceMetadata;
const tools = new Set(["workiq-fetch", "workiq-retrieve", "workiq-get_schema", "workiq-delete_entity"]);
const omitted = { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: null };
const absentResult = { version: 1, source: "sdk-result", applicationError: null, statusCode: null, contentStatus: "not-supplied", resultCount: null };
const entryFields = ["index", "indexKind", "statusCode", "errorCode", "evidenceLevel", "paginationPresent"];
const useful = diagnostic => diagnostic && ["recorded", "redacted"].includes(diagnostic.status)
    && [diagnostic.message, ...(diagnostic.details ?? []).map(detail => detail.message)]
        .some(text => typeof text === "string" && text.trim() && text.trim().toLowerCase() !== "failure");
const privacyDisposition = diagnostic => diagnostic?.version === 1 && diagnostic.source === "completion-error"
    && diagnostic.status === "sensitive-excluded" && diagnostic.code === "failure"
    && Object.keys(diagnostic).every(key => ["version", "source", "status", "code"].includes(key));
const targetKey = target => JSON.stringify([target.sourceSessionId, target.call.toolCallId]);

function validatePlan(plan) {
    validateMaintenancePlan(plan);
    requireThat(Array.isArray(plan.targets) && plan.targets.length > 0 && plan.targets.length <= 9, "A sealed cohort of one to nine exact calls is required.");
    const seen = new Set(), contexts = new Map(), records = new Map();
    for (const target of plan.targets) {
        shape(target, ["scenarioId", "sourceSessionId", "interactionRef", "recordSha256", "prompt", "call", "sourceEvent", "checkpointContextSha256"]);
        requireThat(id(target.scenarioId) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.sourceSessionId)
            && /^interaction-[a-f0-9]{32}$/.test(target.interactionRef) && sha(target.recordSha256) && sha(target.checkpointContextSha256),
        "Invalid exact cohort binding.");
        shape(target.prompt, ["sourceEventId", "sourceTimestamp", "textSha256"]);
        requireThat(id(target.prompt.sourceEventId) && instant(target.prompt.sourceTimestamp) && sha(target.prompt.textSha256), "Invalid cohort prompt binding.");
        shape(target.call, ["tool", "toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"]);
        const call = target.call;
        requireThat(tools.has(call.tool) && [call.toolCallId, call.startEventId, call.completionEventId].every(id)
            && instant(call.startedAt) && instant(call.completedAt) && Date.parse(call.startedAt) >= Date.parse(target.prompt.sourceTimestamp)
            && Date.parse(call.completedAt) >= Date.parse(call.startedAt), "Unsupported or unordered cohort call.");
        shape(target.sourceEvent, ["offset", "bytes", "sha256", "startupBytes", "startupSha256"]);
        const source = target.sourceEvent;
        requireThat(Number.isSafeInteger(source.startupBytes) && source.startupBytes > 0 && source.startupBytes <= 65536
            && Number.isSafeInteger(source.offset) && source.offset >= source.startupBytes && Number.isSafeInteger(source.bytes)
            && source.bytes > 0 && source.bytes <= 1024 ** 2 && Number.isSafeInteger(source.offset + source.bytes)
            && sha(source.sha256) && sha(source.startupSha256), "Invalid bounded original completion pin.");
        for (const [kind, value] of [["call", call.toolCallId], ["event", call.startEventId], ["event", call.completionEventId]]) {
            const key = JSON.stringify([target.sourceSessionId, kind, value]);
            requireThat(!seen.has(key), "Duplicate cohort call or event identity."); seen.add(key);
        }
        requireThat(!contexts.has(target.sourceSessionId) || contexts.get(target.sourceSessionId) === target.checkpointContextSha256,
            "One source cannot have conflicting checkpoint preimages.");
        requireThat(!records.has(target.scenarioId) || records.get(target.scenarioId) === target.recordSha256, "Conflicting record preimages.");
        contexts.set(target.sourceSessionId, target.checkpointContextSha256); records.set(target.scenarioId, target.recordSha256);
    }
}

function addDiagnostic(existing, proposed) {
    const checked = retainedErrorDiagnostic(proposed);
    if (existing !== undefined) {
        same(existing, checked, "Existing diagnostic differs from the bound source; no overwrite is allowed.");
        return existing;
    }
    return useful(checked) || privacyDisposition(checked) ? checked : undefined;
}

// Correspondence is between explicit source-array entries, never requested target positions.
function enrich(call, source) {
    const { diagnostic, ...flags } = call.failureEvidence ?? {};
    same(flags, omitted, "Cohort target has different or stronger failure metadata.");
    requireThat(call.toolSucceeded === false && call.reportedOutcome === "failed" && Array.isArray(call.apiResults), "Cohort target is not a recorded failed call.");
    if (call.resultEvidence != null) same(call.resultEvidence, absentResult, "Existing result carrier is outside the reviewed missing-diagnostic shape.");
    const next = structuredClone(call);
    const parent = addDiagnostic(diagnostic, source.failureEvidence?.diagnostic);
    if (parent) next.failureEvidence.diagnostic = parent;
    if (call.apiResults.length) {
        requireThat(call.apiResults.length === source.apiResults.length, "Existing returned-entry population differs from the original source.");
        next.apiResults = call.apiResults.map((entry, index) => {
            requireThat(Object.keys(entry).every(key => [...entryFields, "errorDiagnostic"].includes(key)), "Unsupported existing returned-entry fields cannot be reattributed.");
            for (const key of entryFields) same(entry[key] ?? null, source.apiResults[index][key] ?? null, "Existing returned-entry facts differ from the original source.");
            const diagnostic = addDiagnostic(entry.errorDiagnostic, source.apiResults[index].errorDiagnostic);
            return diagnostic ? { ...entry, errorDiagnostic: diagnostic } : entry;
        });
    } else if (source.apiResults.some(entry => useful(retainedErrorDiagnostic(entry.errorDiagnostic)))) {
        next.apiResults = structuredClone(source.apiResults);
    }
    return next;
}

export function runFailureCohortMaintenance(options, hooks) {
    const projections = new Map(), preimages = new Map();
    return runMetadataMaintenance(options, {
        validatePlan,
        async validateState(state, plan, config, records, index) {
            requireMatchedReaders();
            for (const target of plan.targets) {
                validateUnassessed(state, { ...plan, targets: [target] }, config, records);
                const blockedEvents = new Set(state.deletion?.events ?? []), blockedCalls = new Set([
                    ...(state.deletion?.identities ?? []), ...(state.deletion?.contextCalls ?? [])]);
                requireThat(![target.prompt.sourceEventId, target.call.startEventId, target.call.completionEventId]
                    .some(event => blockedEvents.has(eventIdentity(target.sourceSessionId, event)))
                    && !blockedCalls.has(callIdentity(target.sourceSessionId, target.call.toolCallId)), "Cohort deletion conflict.");
                const source = index.sources?.[target.sourceSessionId], cursor = source?.cursor;
                requireThat(source?.scanned === true && !source.error && cursor && cursor.offset === cursor.logBytes
                    && cursor.backlogBytes === 0 && cursor.partialBytes === 0 && cursor.skipping === false && source.backfillPending !== true,
                "Cohort source cursor is incomplete or unavailable.");
                const tail = cursor.droppedBytes > 0;
                requireThat(tail ? source.backfill?.phase === "visited" && source.backfill.omittedBytes === cursor.droppedBytes
                    && typeof source.backfill.boundaryGap === "boolean" : source.backfill === undefined,
                "Cohort source prefix is not independently qualified.");
                const file = await safeDeletionFile(options.dataDir, path.join("collector", index.fingerprint, `${target.sourceSessionId}.json`));
                requireThat((await lstat(file)).isFile(), "Cohort checkpoint file must exist.");
                const event = await readBoundFailureCompletion(config, target, { consumedCursor: cursor, tailRetrieve: tail });
                requireThat(Buffer.byteLength(event.data.error.message) <= 8192, "This cohort accepts only bounded original error messages.");
                const retained = JSON.parse(JSON.stringify(retainEvent(event, { credentialExclusions: 0 })));
                const projected = completeWorkIqCall({ startedAt: target.call.startedAt }, retained);
                requireThat(projected.resultEvidence?.contentStatus !== "partial"
                    && (projected.resultEvidence?.resultCount == null || projected.resultEvidence.resultCount === projected.apiResults.length)
                    && (useful(retainedErrorDiagnostic(projected.failureEvidence?.diagnostic))
                        || privacyDisposition(retainedErrorDiagnostic(projected.failureEvidence?.diagnostic))
                        || projected.apiResults.some(entry => useful(retainedErrorDiagnostic(entry.errorDiagnostic)))),
                "Original source supplies neither useful safe diagnostics nor a qualified privacy-only disposition.");
                projections.set(targetKey(target), projected);
            }
        },
        projectRecords(records, plan) {
            for (const target of plan.targets) {
                requireThat(records.filter(record => record.scenarioId === target.scenarioId).length === 1
                    && records.flatMap(record => record.sourceSessionId === target.sourceSessionId ? record.toolCalls ?? [] : [])
                        .filter(call => call.toolCallId === target.call.toolCallId || call.startEventId === target.call.startEventId
                            || call.completionEventId === target.call.completionEventId).length === 1, "Cohort identity is missing or ambiguous.");
            }
            return records.map(record => {
                const targets = plan.targets.filter(target => target.scenarioId === record.scenarioId);
                if (!targets.length) return record;
                requireThat(digest(record) === targets[0].recordSha256, "Cohort committed record preimage changed.");
                const next = structuredClone(record);
                for (const target of targets) {
                    const prompt = record.userPrompt;
                    requireThat(record.sourceSessionId === target.sourceSessionId && prompt?.status === "full"
                        && prompt.sourceEventId === target.prompt.sourceEventId && prompt.sourceTimestamp === target.prompt.sourceTimestamp
                        && typeof prompt.text === "string" && digestText(prompt.text) === target.prompt.textSha256, "Cohort prompt binding changed.");
                    const position = record.toolCalls.findIndex(call => call.toolCallId === target.call.toolCallId), call = record.toolCalls[position];
                    for (const key of Object.keys(target.call)) same(call[key], target.call[key], "Cohort call identity/timing changed.");
                    preimages.set(targetKey(target), call);
                    const enriched = enrich(call, projections.get(targetKey(target)));
                    requireThat(digest(enriched) !== digest(call), "Target has no source-proved missing diagnostic to add.");
                    next.toolCalls[position] = enriched;
                }
                return next;
            });
        },
        projectCheckpoint(checkpoint, sourceId, plan, state, index, { allowPostimage }) {
            const targets = plan.targets.filter(target => target.sourceSessionId === sourceId);
            requireThat(checkpoint.schemaVersion === 1 && Array.isArray(checkpoint.events) && contextFits(checkpoint.events), "Invalid bounded cohort checkpoint.");
            same(checkpoint.cursor, index.sources[sourceId].cursor, "Cohort checkpoint cursor differs from the index.");
            if (!allowPostimage) requireThat(digest(checkpoint) === targets[0].checkpointContextSha256, "Cohort checkpoint preimage changed.");
            const next = structuredClone(checkpoint);
            for (const target of targets) {
                const prompt = next.events.filter(event => event.id === target.prompt.sourceEventId);
                requireThat(prompt.length === 1 && prompt[0].type === "user.message" && prompt[0].timestamp === target.prompt.sourceTimestamp
                    && typeof prompt[0].data?.content === "string" && digestText(prompt[0].data.content) === target.prompt.textSha256,
                "Cohort checkpoint prompt boundary is missing or conflicting.");
                const starts = next.events.filter(event => event.id === target.call.startEventId
                    || event.type === "tool.execution_start" && event.data?.toolCallId === target.call.toolCallId);
                const ends = next.events.filter(event => event.id === target.call.completionEventId
                    || event.type === "tool.execution_complete" && event.data?.toolCallId === target.call.toolCallId);
                if (starts.length === 0 && ends.length === 0) {
                    requireThat(!next.events.some(event => event.data?.toolCallId === target.call.toolCallId
                        || event.data?.parentToolCallId === target.call.toolCallId || event.data?.wireToolRequestIds?.includes(target.call.toolCallId)),
                    "Cohort call context is incomplete, not aged out.");
                    continue;
                }
                requireThat(starts.length === 1 && ends.length === 1 && starts[0].id === target.call.startEventId
                    && starts[0].type === "tool.execution_start" && starts[0].data?.toolCallId === target.call.toolCallId
                    && starts[0].timestamp === target.call.startedAt && starts[0].data.toolName === target.call.tool
                    && ends[0].type === "tool.execution_complete" && ends[0].id === target.call.completionEventId && ends[0].timestamp === target.call.completedAt
                    && ends[0].data?.toolCallId === target.call.toolCallId && ends[0].data.success === false,
                "Cohort checkpoint call is partial or ambiguous.");
                const event = ends[0], call = completeWorkIqCall({ startedAt: target.call.startedAt }, event);
                const enriched = enrich(call, projections.get(targetKey(target)));
                if (!allowPostimage && preimages.has(targetKey(target))) {
                    same(call.apiResults, preimages.get(targetKey(target)).apiResults, "Checkpoint and committed returned facts disagree.");
                    same(call.failureEvidence, preimages.get(targetKey(target)).failureEvidence, "Checkpoint and committed failure facts disagree.");
                }
                if (enriched.failureEvidence.diagnostic) event.data.wireFailureEvidence.diagnostic = enriched.failureEvidence.diagnostic;
                const entries = event.data.result?.structuredContent?.results;
                requireThat(Array.isArray(entries), "Existing checkpoint returned-result projection is unsupported.");
                if (entries.length) {
                    requireThat(entries.length === enriched.apiResults.length, "Checkpoint entry population differs.");
                    enriched.apiResults.forEach((entry, index) => {
                        if (entry.errorDiagnostic) entries[index].wireErrorDiagnostic = entry.errorDiagnostic;
                    });
                } else event.data.result.structuredContent.results = enriched.apiResults.map(entry => ({
                    statusCode: entry.statusCode, error: entry.errorCode ? { code: entry.errorCode } : null,
                    ...(entry.errorDiagnostic ? { wireErrorDiagnostic: entry.errorDiagnostic } : {}),
                }));
            }
            requireThat(contextFits(next.events), "Cohort diagnostic additions exceed checkpoint bounds; nothing is evicted.");
            same(filterDeletedEvents(next.events, sourceId, state.deletion), next.events, "Cohort checkpoint deletion conflict.");
            return next;
        },
    }, hooks);
}
