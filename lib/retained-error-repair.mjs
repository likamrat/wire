import { isDeepStrictEqual } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { retainEvent } from "./collector.mjs";
import { completeWorkIqCall } from "./history.mjs";
import { buildRequestActivity } from "./activity-analytics.mjs";
import { filterDeletedEvents, filterDeletedRecords } from "./deletion-identities.mjs";
import { contextFits, hash, TAIL_LIMITS } from "./collector-io.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { readBoundFailureCompletion } from "./failure-evidence-maintenance.mjs";
import { runMetadataMaintenance, validateMaintenancePlan, maintenanceMetadata, maintenanceStateGuard, inspectMaintenanceState } from "./historical-maintenance.mjs";
import { loadBoardState, resolveDataDir } from "./store.mjs";
import { validateCollectorIndex } from "./collector-index.mjs";
import { assessmentSource } from "./assessment-read-model.mjs";
import { BOARD_ID } from "./evidence.mjs";
import { bindSourceHost } from "./source-host.mjs";
import { completionReferenceStore, validateCompletionReferenceFence, retainedCompletionFields, applyRetainedCompletionFields,
    hydrateCheckpointReferences, referenceCheckpointEvent, referencedCheckpoint } from "./checkpoint-references.mjs";
import { WORKIQ_TOOLS } from "./assessment-contract.mjs";
import { retainedErrorDiagnostic } from "./failure-details.mjs";
import { normalizeResultEvidence } from "./result-evidence.mjs";

const { digest, sha, id, instant, requireThat, same, shape } = maintenanceMetadata;
export const retainedErrorTargetKey = target => JSON.stringify([target.sourceSessionId, target.call.toolCallId]);
const sourceId = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? "");
const carriers = call => ({ failureEvidence: call.failureEvidence, resultEvidence: call.resultEvidence, apiResults: call.apiResults });
const diagnostics = call => [call.failureEvidence?.diagnostic, call.resultEvidence?.diagnostic,
    ...(call.apiResults ?? []).map(entry => entry.errorDiagnostic)].filter(Boolean);
const readable = call => diagnostics(call).some(value => [value.message, ...(value.details ?? []).map(detail => detail.message)]
    .some(text => typeof text === "string" && text.trim() && text.trim().toLowerCase() !== "failure"));
function preserveDiagnosticFacts(before, after) {
    if (before == null) return;
    same(retainedErrorDiagnostic(before), before, "Unsupported existing diagnostic fields cannot be discarded.");
    for (const [prior, next] of [[before, after], ...(before.details ?? []).map((detail, index) => [detail, after?.details?.[index]])]) {
        for (const key of ["code", "statusCode"]) if (prior[key] != null && prior[key] !== "failure") {
            same(next?.[key], prior[key], "An existing diagnostic code or status conflicts with the original.");
        }
    }
}
const counts = records => {
    const activity = buildRequestActivity(records);
    return { toolCalls: activity.tool.length, failedCalls: activity.tool.filter(row => row.outcome === "failure").length,
        returnedEntries: activity["reported-api"].length };
};

function validatePlan(plan) {
    validateMaintenancePlan(plan, { retainedErrors: true });
    validateScope(plan);
}

function validateScope(plan) {
    const scope = plan.retainedErrorRepair;
    shape(scope, ["version", "olderRetainedTargets", "referenceTargets", "readableTargets", "noCauseTargets", "occurrences", "before", "after"]);
    requireThat(scope.version === 1 && Array.isArray(plan.targets) && plan.targets.length > 0 && plan.targets.length <= 32,
        "A bounded sealed retained-error cohort is required.");
    for (const value of [scope.before, scope.after]) {
        shape(value, ["toolCalls", "failedCalls", "returnedEntries"]);
        requireThat(Object.values(value).every(number => Number.isSafeInteger(number) && number >= 0), "Invalid retained-error population.");
    }
    requireThat(scope.before.toolCalls === scope.after.toolCalls && scope.before.failedCalls === scope.after.failedCalls,
        "Retained-error restoration cannot change tool membership or outcomes.");
    const keys = new Set(), aliases = new Set(), recordPins = new Map(), checkpointPins = new Map();
    let occurrences = 0, originalBytes = 0;
    for (const target of plan.targets) {
        shape(target, ["sourceSessionId", "call", "aliases", "sourceEvent", "sourceStart", "checkpointContextSha256", "proposedCarriersSha256"]);
        const call = target.call;
        shape(call, ["tool", "toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"]);
        requireThat(sourceId(target.sourceSessionId) && WORKIQ_TOOLS.includes(call.tool)
            && [call.toolCallId, call.startEventId, call.completionEventId].every(id)
            && instant(call.startedAt) && instant(call.completedAt) && Date.parse(call.completedAt) >= Date.parse(call.startedAt)
            && sha(target.checkpointContextSha256) && sha(target.proposedCarriersSha256), "Invalid retained-error call binding.");
        const key = retainedErrorTargetKey(target);
        requireThat(!keys.has(key), "Duplicate canonical repair target."); keys.add(key);
        requireThat(Array.isArray(target.aliases) && target.aliases.length > 0 && target.aliases.length <= 4, "Seal every retained alias.");
        for (const alias of target.aliases) {
            shape(alias, ["scenarioId", "recordSha256", "prompt"]);
            shape(alias.prompt, ["sourceEventId", "sourceTimestamp", "textSha256"]);
            requireThat(id(alias.scenarioId) && sha(alias.recordSha256) && id(alias.prompt.sourceEventId)
                && instant(alias.prompt.sourceTimestamp) && sha(alias.prompt.textSha256)
                && Date.parse(alias.prompt.sourceTimestamp) <= Date.parse(call.startedAt), "Invalid retained alias or prompt binding.");
            const aliasKey = JSON.stringify([alias.scenarioId, key]);
            requireThat(!aliases.has(aliasKey), "Duplicate physical repair target."); aliases.add(aliasKey);
            requireThat(!recordPins.has(alias.scenarioId) || recordPins.get(alias.scenarioId) === alias.recordSha256, "Conflicting record preimages.");
            recordPins.set(alias.scenarioId, alias.recordSha256); occurrences++;
        }
        requireThat(!checkpointPins.has(target.sourceSessionId)
            || checkpointPins.get(target.sourceSessionId) === target.checkpointContextSha256, "Conflicting checkpoint preimages.");
        checkpointPins.set(target.sourceSessionId, target.checkpointContextSha256);
        const original = target.sourceEvent;
        shape(original, ["offset", "bytes", "sha256", "startupBytes", "startupSha256"]);
        requireThat(Number.isSafeInteger(original.startupBytes) && original.startupBytes > 0 && original.startupBytes <= 65536
            && Number.isSafeInteger(original.offset) && original.offset >= original.startupBytes
            && Number.isSafeInteger(original.bytes) && original.bytes > 0 && original.bytes <= 1024 ** 2
            && Number.isSafeInteger(original.offset + original.bytes) && sha(original.sha256) && sha(original.startupSha256),
        "Invalid exact original completion region.");
        const start = target.sourceStart;
        shape(start, ["offset", "bytes", "sha256"]);
        requireThat(Number.isSafeInteger(start.offset) && start.offset >= original.startupBytes
            && Number.isSafeInteger(start.bytes) && start.bytes > 0 && start.bytes <= TAIL_LIMITS.maxLineBytes
            && start.offset + start.bytes <= original.offset && sha(start.sha256), "Invalid exact original start region.");
        originalBytes += original.startupBytes + original.bytes + start.bytes;
    }
    requireThat(occurrences === scope.occurrences && occurrences <= 64, "Retained alias count differs from the reviewed scope.");
    requireThat(originalBytes <= TAIL_LIMITS.cycleBytes, "The sealed original regions exceed the existing per-cycle read budget.");
    for (const name of ["olderRetainedTargets", "referenceTargets", "readableTargets", "noCauseTargets"]) {
        const list = scope[name];
        requireThat(Array.isArray(list) && list.length <= 32 && new Set(list).size === list.length
            && list.every(key => keys.has(key)), "Repair choices must name exact sealed targets.");
    }
    requireThat(scope.readableTargets.length + scope.noCauseTargets.length === keys.size
        && !scope.readableTargets.some(key => scope.noCauseTargets.includes(key)),
    "Every target needs one reviewed restoration category.");
}

function authorizeRetainedWindow(plan, outside, { until }) {
    same(outside.map(retainedErrorTargetKey).sort(), [...plan.retainedErrorRepair.olderRetainedTargets].sort(),
        "The named older-retained exception no longer matches the collection window.");
    requireThat(outside.every(target => Date.parse(target.call.completedAt) <= until),
        "A retained-only exception cannot admit future or unobserved completions.");
    return true;
}

export function createRetainedErrorRepairPolicy(dataDir) {
    const projections = new Map();
    let proposedRecords;
    return {
        validatePlan, authorizeRetainedWindow, finishSealedPostimage: true,
        async validateState(state, plan, config, records, index, { allowPostimage = false } = {}) {
            if (allowPostimage) proposedRecords = records;
            for (const target of plan.targets) {
                const actual = records.filter(record => record.sourceSessionId === target.sourceSessionId)
                    .flatMap(record => (record.toolCalls ?? []).filter(call => call.toolCallId === target.call.toolCallId)
                        .map(call => ({ record, call })));
                same(actual.map(value => value.record.scenarioId).sort(), target.aliases.map(alias => alias.scenarioId).sort(),
                    "Original reads require the complete sealed retained alias population.");
                for (const alias of target.aliases) {
                    const { record, call } = actual.find(value => value.record.scenarioId === alias.scenarioId);
                    requireThat(record.sourceHost === "copilot-app" && !record.sample
                        && (allowPostimage ? digest(carriers(call)) === target.proposedCarriersSha256 : digest(record) === alias.recordSha256)
                        && record.userPrompt?.sourceEventId === alias.prompt.sourceEventId
                        && record.userPrompt.sourceTimestamp === alias.prompt.sourceTimestamp
                        && typeof record.userPrompt.text === "string" && hash(record.userPrompt.text) === alias.prompt.textSha256
                        && call.toolSucceeded === false && call.reportedOutcome === "failed", "Retained identity or preimage changed before the original read.");
                    for (const [key, value] of Object.entries(target.call)) same(call[key], value, "Original read call binding changed.");
                }
                const row = index.sources?.[target.sourceSessionId], cursor = row?.cursor;
                requireThat(row?.scanned === true && !row.error && cursor && cursor.offset === cursor.logBytes
                    && cursor.partialBytes === 0 && cursor.backlogBytes === 0 && cursor.skipping === false,
                "The retained source cursor must be complete and unchanged.");
                const file = await safeDeletionFile(dataDir, path.join("collector", index.fingerprint, target.sourceSessionId + ".json"));
                requireThat((await lstat(file)).isFile(), "An existing checkpoint is required; no context is reconstructed.");
                const event = await readBoundFailureCompletion(config, target, { consumedCursor: cursor, retainedOnly: true });
                const retained = JSON.parse(JSON.stringify(retainEvent(event, { credentialExclusions: 0 })));
                const projected = completeWorkIqCall({ ...target.call }, retained);
                same(digest(carriers(projected)), target.proposedCarriersSha256, "The original diagnostic projection changed.");
                retainedCompletionFields(projected);
                const key = retainedErrorTargetKey(target);
                requireThat(plan.retainedErrorRepair.readableTargets.includes(key) ? readable(projected)
                    : projected.failureEvidence?.messageSignal === "retrieval-stopped-error"
                        && projected.failureEvidence?.diagnostic?.status === "not-supplied" && !readable(projected),
                "The original source does not establish the selected restoration category.");
                projections.set(key, projected);
            }
        },
        projectIndex(index, plan, state) {
            const store = completionReferenceStore(state, dataDir);
            requireThat(index.schemaVersion !== 4 || index.completionReferenceStore === store, "Repair belongs to another store.");
            const sourceKey = source => JSON.stringify([source.fingerprint, source.sourceSessionId]);
            const registry = new Map((index.completionReferenceSources ?? []).map(source => [sourceKey(source), source]));
            for (const target of plan.targets.filter(target => plan.retainedErrorRepair.referenceTargets.includes(retainedErrorTargetKey(target)))) {
                const source = { fingerprint: index.fingerprint, sourceSessionId: target.sourceSessionId };
                registry.set(sourceKey(source), source);
            }
            const { completionReferenceMaintenance, ...rest } = index;
            return { ...rest, schemaVersion: 4, completionReferenceVersion: 1, completionReferenceStore: store,
                completionReferenceSources: [...registry.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))) };
        },
        projectRecords(records, plan) {
            same(counts(records), plan.retainedErrorRepair.before, "The reviewed canonical population changed.");
            const next = structuredClone(records);
            for (const target of plan.targets) {
                const actual = records.filter(record => record.sourceSessionId === target.sourceSessionId)
                    .flatMap(record => (record.toolCalls ?? []).filter(call => call.toolCallId === target.call.toolCallId)
                        .map(call => ({ record, call })));
                same(actual.map(value => value.record.scenarioId).sort(), target.aliases.map(alias => alias.scenarioId).sort(),
                    "The canonical target's complete retained alias set changed.");
                for (const alias of target.aliases) {
                    const match = actual.find(value => value.record.scenarioId === alias.scenarioId);
                    const { record, call } = match, prompt = record.userPrompt;
                    requireThat(record.sourceHost === "copilot-app" && !record.sample && digest(record) === alias.recordSha256
                        && prompt?.sourceEventId === alias.prompt.sourceEventId && prompt.sourceTimestamp === alias.prompt.sourceTimestamp
                        && typeof prompt.text === "string" && hash(prompt.text) === alias.prompt.textSha256,
                    "The retained record or unchanged prompt preimage differs.");
                    for (const [key, value] of Object.entries(target.call)) same(call[key], value, "The retained call identity or timing differs.");
                    requireThat(call.toolSucceeded === false && call.reportedOutcome === "failed" && !readable(call)
                        && !diagnostics(call).some(value => value.status === "sensitive-excluded"), "Existing stronger/private diagnostic evidence cannot be replaced.");
                    const projected = projections.get(retainedErrorTargetKey(target));
                    requireThat(!isDeepStrictEqual(carriers(call), carriers(projected)), "Every sealed occurrence must have a qualified missing fact to restore.");
                    if (call.failureEvidence != null) {
                        requireThat(call.failureEvidence.version === 1 && Object.keys(call.failureEvidence).every(key =>
                            ["version", "reason", "code", "messageStatus", "messageSignal", "messageSource", "diagnostic"].includes(key)),
                        "Unsupported existing failure fields cannot be discarded.");
                        for (const key of ["code", "messageSignal", "messageSource"]) {
                            if (call.failureEvidence[key] != null && call.failureEvidence[key] !== "failure") {
                                same(projected.failureEvidence?.[key], call.failureEvidence[key], "An existing qualified failure fact conflicts with the original.");
                            }
                        }
                    }
                    if (call.resultEvidence != null) {
                        same(normalizeResultEvidence(call.resultEvidence), call.resultEvidence, "Unsupported existing result fields cannot be discarded.");
                        for (const key of ["applicationError", "statusCode", "resultCount", "statusConflict", "description"]) {
                            if (call.resultEvidence[key] != null) same(projected.resultEvidence?.[key], call.resultEvidence[key],
                                "An existing qualified result fact conflicts with the original.");
                        }
                    }
                    preserveDiagnosticFacts(call.failureEvidence?.diagnostic, projected.failureEvidence?.diagnostic);
                    preserveDiagnosticFacts(call.resultEvidence?.diagnostic, projected.resultEvidence?.diagnostic);
                    requireThat(Array.isArray(call.apiResults), "Existing returned-entry membership is unavailable.");
                    if (call.apiResults.length) {
                        requireThat(call.apiResults.length === projected.apiResults.length, "Existing returned-entry membership cannot be replaced.");
                        call.apiResults.forEach((entry, position) => {
                            preserveDiagnosticFacts(entry.errorDiagnostic, projected.apiResults[position].errorDiagnostic);
                            for (const [key, value] of Object.entries(entry)) if (key !== "errorDiagnostic" && value != null) {
                                same(projected.apiResults[position][key], value, "An existing returned-entry fact conflicts with the original.");
                            }
                        });
                    }
                    const changed = next.find(value => value.scenarioId === alias.scenarioId);
                    changed.toolCalls = changed.toolCalls.map(value => value.toolCallId === call.toolCallId
                        ? { ...value, ...structuredClone(carriers(projected)) } : value);
                }
            }
            same(buildRequestActivity(next).tool, buildRequestActivity(records).tool, "Tool membership or outcomes changed.");
            same(counts(next), plan.retainedErrorRepair.after, "Restored returned-entry counts differ from the approved delta.");
            proposedRecords = next;
            return next;
        },
        projectCheckpoint(checkpoint, sourceSessionId, plan, state, index, { allowPostimage }) {
            const targets = plan.targets.filter(target => target.sourceSessionId === sourceSessionId);
            requireThat(checkpoint && [1, 2].includes(checkpoint.schemaVersion) && contextFits(checkpoint.events), "The existing context is missing or out of bounds.");
            same(checkpoint.cursor, index.sources[sourceSessionId].cursor, "Checkpoint and index cursor disagree.");
            if (!allowPostimage) same(digest(checkpoint), targets[0].checkpointContextSha256, "The checkpoint preimage changed.");
            let next = structuredClone(checkpoint);
            for (const target of targets) {
                const key = retainedErrorTargetKey(target), call = target.call;
                const starts = next.events.filter(event => event.id === call.startEventId || event.type === "tool.execution_start" && event.data?.toolCallId === call.toolCallId);
                const ends = next.events.filter(event => event.id === call.completionEventId || event.type === "tool.execution_complete" && event.data?.toolCallId === call.toolCallId);
                if (!starts.length && !ends.length) {
                    requireThat(!plan.retainedErrorRepair.referenceTargets.includes(key)
                        && !next.events.some(event => event.data?.toolCallId === call.toolCallId
                            || event.data?.parentToolCallId === call.toolCallId || event.data?.wireToolRequestIds?.includes(call.toolCallId)),
                    "A referenced or partial call context cannot be reconstructed.");
                    continue;
                }
                requireThat(starts.length === 1 && ends.length === 1 && starts[0].id === call.startEventId
                    && starts[0].timestamp === call.startedAt && starts[0].data.toolName === call.tool
                    && ends[0].id === call.completionEventId && ends[0].timestamp === call.completedAt
                    && ends[0].data.success === false, "Cached source/call/completion identity conflicts.");
                if (plan.retainedErrorRepair.referenceTargets.includes(key)) {
                    const inline = checkpoint.events.map(event => event.id === call.completionEventId
                        ? applyRetainedCompletionFields(event, retainedCompletionFields(projections.get(key))) : event);
                    requireThat(!contextFits(inline), "A reference is permitted only for an individually capacity-blocked carrier.");
                    next = referenceCheckpointEvent(next, call.completionEventId);
                }
                else {
                    const fields = retainedCompletionFields(projections.get(key));
                    next.events = next.events.map(event => event.id === call.completionEventId ? applyRetainedCompletionFields(event, fields) : event);
                }
            }
            if (next.schemaVersion === 2 || next.events.some(event => event.data?.wireCompletionRef !== undefined)) next = referencedCheckpoint(next, index, sourceSessionId);
            requireThat(contextFits(next.events), "Diagnostic restoration exceeds the existing context bound; nothing was evicted.");
            same(filterDeletedEvents(next.events, sourceSessionId, state.deletion), next.events, "A repair target conflicts with deletion.");
            same(filterDeletedRecords(proposedRecords, state.deletion), proposedRecords, "A repaired record conflicts with deletion.");
            hydrateCheckpointReferences(next, { state, dataDir, index, sourceSessionId, records: proposedRecords });
            return next;
        },
    };
}

export function runRetainedErrorRepair(options, hooks) {
    return runMetadataMaintenance(options, createRetainedErrorRepairPolicy(options.dataDir), hooks);
}

// This observer never acquires a writer, prepares a journal, or installs a compatibility fence.
export async function inspectRetainedErrorRepair({ dataDir, targets, retainedErrorRepair }) {
    requireThat(typeof dataDir === "string" && path.isAbsolute(dataDir), "Read-only repair inspection requires an explicit absolute store.");
    validateScope({ targets, retainedErrorRepair });
    const dir = resolveDataDir({ dataDir }), session = { dataDir: dir };
    const file = relative => safeDeletionFile(dir, relative);
    const stateFile = await file(`${BOARD_ID}.state.json`);
    const configFile = await file(path.join("collector", "config.json")), indexFile = await file(path.join("collector", "index.json"));
    const [stateBytes, configBytes, indexBytes] = await Promise.all([stateFile, configFile, indexFile].map(value => readFile(value)));
    const state = await loadBoardState(session, { readOnly: true }), config = JSON.parse(configBytes), index = validateCollectorIndex(JSON.parse(indexBytes));
    requireThat(!index.completionReferenceMaintenance, "An existing repair is unfinished; inspect its sealed journal instead.");
    await bindSourceHost(session, config);
    if (index.schemaVersion === 4) validateCompletionReferenceFence(index, state, dir);
    same(JSON.parse(JSON.stringify(state)), JSON.parse(stateBytes), "Read-only inspection would reinterpret the stored board.");
    const snapshotBytes = await readFile(await file(path.join("private-evidence", state.evidenceFile)));
    requireThat(hash(snapshotBytes) + ".json" === state.evidenceFile, "Current evidence snapshot failed integrity validation.");
    const snapshot = JSON.parse(snapshotBytes), policy = createRetainedErrorRepairPolicy(dir);
    const plan = { targets, retainedErrorRepair, stateGuardSha256: maintenanceStateGuard(state),
        source: { configSha256: hash(configBytes), indexSha256: hash(indexBytes), ...assessmentSource(state, config), windowDays: config.windowDays } };
    validateScope(plan);
    const noDispatchReason = inspectMaintenanceState(state, plan, config, policy);
    await policy.validateState(state, plan, config, snapshot.records, index);
    const nextIndex = validateCollectorIndex(policy.projectIndex(index, plan, state)), records = policy.projectRecords(snapshot.records, plan);
    const checkpoints = [];
    for (const sourceSessionId of [...new Set(targets.map(target => target.sourceSessionId))].sort()) {
        const relative = path.join("collector", index.fingerprint, sourceSessionId + ".json"), source = await file(relative);
        const info = await lstat(source);
        requireThat(info.isFile() && info.size <= TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes + 65536,
            "Read-only checkpoint inspection exceeds its existing byte bound.");
        const bytes = await readFile(source);
        requireThat(bytes.length === info.size, "Checkpoint changed during read-only inspection.");
        const before = JSON.parse(bytes), after = policy.projectCheckpoint(before, sourceSessionId, plan, state, nextIndex, { allowPostimage: false });
        checkpoints.push({ sourceSessionId, path: relative, beforeSha256: hash(bytes),
            afterSha256: isDeepStrictEqual(before, after) ? hash(bytes) : digest(after),
            schemaBefore: before.schemaVersion, schemaAfter: after.schemaVersion,
            contextBytesBefore: Buffer.byteLength(JSON.stringify(before.events)), contextBytesAfter: Buffer.byteLength(JSON.stringify(after.events)),
            contextFits: contextFits(after.events), cursorUnchanged: isDeepStrictEqual(before.cursor, after.cursor),
            referenceCount: after.events.filter(event => event.data?.wireCompletionRef === 1).length });
        requireThat(hash(await readFile(source)) === hash(bytes), "Checkpoint changed during read-only inspection.");
    }
    const stable = await Promise.all([stateFile, configFile, indexFile].map(value => readFile(value)));
    same(stable.map(hash), [stateBytes, configBytes, indexBytes].map(hash), "The live read cut changed; no preparation or writes occurred.");
    return { kind: "read-only-retained-error-projection", prepared: false, authorized: false, noDispatchReason,
        stateRevision: state.revision, evidenceRevision: state.evidenceRevision,
        stateSha256: hash(stateBytes), evidenceFile: state.evidenceFile,
        stateGuardSha256: plan.stateGuardSha256, source: plan.source,
        indexBeforeSha256: hash(indexBytes), indexAfterSha256: digest(nextIndex),
        proposedEvidenceFile: digest({ ...snapshot, records }) + ".json",
        canonicalCalls: targets.length, storedOccurrences: retainedErrorRepair.occurrences,
        readableRecoveries: retainedErrorRepair.readableTargets.length, noCauseCorrections: retainedErrorRepair.noCauseTargets.length,
        before: counts(snapshot.records), after: counts(records), checkpoints };
}
