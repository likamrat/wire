import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { BoardError } from "./store.mjs";
import { contextFits } from "./collector-io.mjs";
import { completeWorkIqCall } from "./history.mjs";
import { WORKIQ_TOOLS } from "./assessment-contract.mjs";
import { filterDeletedEvents, filterDeletedRecords } from "./deletion-identities.mjs";

export const COMPLETION_REFERENCE_LIMITS = Object.freeze({ references: 32, hydratedBytes: 64 * 1024 });
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const id = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => { throw Object.assign(new BoardError("Retained completion reference is unavailable or conflicts with its owned evidence. Prior data was retained.", 409),
    { code: "CHECKPOINT_REFERENCE_INVALID" }); };
const require = value => { if (!value) fail(); };
const withinLimit = value => {
    if (!value) throw Object.assign(new BoardError("Referenced completion evidence exceeds its bounded count or hydration budget. Prior data was retained.", 413),
        { code: "CHECKPOINT_REFERENCE_LIMIT" });
};
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const hasCompletionReference = event => Object.hasOwn(event?.data ?? {}, "wireCompletionRef");
export const registeredReferenceSource = (index, fingerprint, sourceSessionId) => index?.schemaVersion === 4
    && Array.isArray(index.completionReferenceSources)
    && index.completionReferenceSources.some(source => source.fingerprint === fingerprint && source.sourceSessionId === sourceSessionId);

export function completionReferenceStore(state, dataDir) {
    require(typeof state?.pseudonymKey === "string" && /^[a-f0-9]{64}$/.test(state.pseudonymKey) && path.isAbsolute(dataDir));
    let physical;
    try { physical = realpathSync.native(dataDir); }
    catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) fail();
        throw error;
    }
    return createHmac("sha256", state.pseudonymKey).update("wire-completion-reference-v1\0" + physical).digest("hex");
}

export function validateCompletionReferenceFence(index, state, dataDir) {
    require(index?.schemaVersion === 4 && index.completionReferenceVersion === 1
        && index.completionReferenceStore === completionReferenceStore(state, dataDir));
}

function completionReferenceBinding(index, sourceSessionId, cursor) {
    require(index?.schemaVersion === 4 && index.completionReferenceVersion === 1 && sha(index.completionReferenceStore)
        && sha(index.fingerprint) && uuid(sourceSessionId) && typeof cursor?.identity === "string"
        && cursor.identity.length > 0 && cursor.identity.length <= 1024);
    return { store: index.completionReferenceStore, fingerprint: index.fingerprint,
        sourceSessionId, sourceIdentity: cursor.identity };
}

// Structural validation also serves deletion: removing a reference must not require its deleted payload.
export function validateReferenceCheckpoint(checkpoint, { index, sourceSessionId, fingerprint = index?.fingerprint } = {}) {
    require(plain(checkpoint) && [1, 2].includes(checkpoint.schemaVersion) && Array.isArray(checkpoint.events));
    const referenced = checkpoint.events.filter(hasCompletionReference);
    if (checkpoint.schemaVersion === 1) {
        require(!referenced.length && checkpoint.completionReferences === undefined);
        return referenced;
    }
    require(index?.schemaVersion === 4 && index.completionReferenceVersion === 1
        && exact(checkpoint.completionReferences, ["store", "fingerprint", "sourceSessionId", "sourceIdentity"])
        && checkpoint.completionReferences.store === index.completionReferenceStore
        && checkpoint.completionReferences.fingerprint === fingerprint
        && checkpoint.completionReferences.sourceSessionId === sourceSessionId
        && checkpoint.completionReferences.sourceIdentity === checkpoint.cursor?.identity
        && sha(checkpoint.completionReferences.store)
        && typeof checkpoint.completionReferences.sourceIdentity === "string"
        && /^[A-Za-z0-9_.:-]{1,1024}$/.test(checkpoint.completionReferences.sourceIdentity)
        && registeredReferenceSource(index, fingerprint, sourceSessionId)
        && sha(fingerprint) && uuid(sourceSessionId) && contextFits(checkpoint.events)
        && !Object.hasOwn(checkpoint, "backfill") && !Object.hasOwn(checkpoint, "backfillSource")
        && Object.keys(checkpoint).every(key => ["schemaVersion", "cursor", "events", "diagnostics", "completionReferences"].includes(key)));
    withinLimit(referenced.length <= COMPLETION_REFERENCE_LIMITS.references);
    const seen = new Set();
    for (const event of referenced) {
        require(event.type === "tool.execution_complete" && event.data.wireCompletionRef === 1
            && event.data.success === false && id(event.id) && id(event.data.toolCallId)
            && typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp))
            && !seen.has("event:" + event.id) && !seen.has("call:" + event.data.toolCallId));
        seen.add("event:" + event.id); seen.add("call:" + event.data.toolCallId);
    }
    return referenced;
}

export function retainedCompletionFields(call) {
    require(call?.toolSucceeded === false && call.reportedOutcome === "failed" && WORKIQ_TOOLS.includes(call.tool)
        && id(call.toolCallId) && id(call.startEventId) && id(call.completionEventId)
        && typeof call.startedAt === "string" && typeof call.completedAt === "string"
        && Number.isFinite(Date.parse(call.startedAt)) && Date.parse(call.completedAt) >= Date.parse(call.startedAt)
        && Array.isArray(call.apiResults) && call.apiResults.length <= 100 && call.failureEvidence?.version === 1);
    const results = call.apiResults.map((entry, index) => {
        require(entry.index === index);
        return { statusCode: entry.statusCode, error: entry.errorCode ? { code: entry.errorCode } : null,
            ...(entry.errorDiagnostic ? { wireErrorDiagnostic: entry.errorDiagnostic } : {}),
            ...(entry.paginationPresent ? { body: { "@odata.nextLink": "[present; URL excluded]" } } : {}) };
    });
    const fields = { wireFailureEvidence: call.failureEvidence, wireResultEvidence: call.resultEvidence,
        results };
    const checked = completeWorkIqCall({ startedAt: call.startedAt }, { id: call.completionEventId, timestamp: call.completedAt,
        data: { toolCallId: call.toolCallId, success: false, ...fields, result: { structuredContent: { results } } } });
    require(isDeepStrictEqual(checked.failureEvidence, call.failureEvidence)
        && isDeepStrictEqual(checked.resultEvidence, call.resultEvidence) && isDeepStrictEqual(checked.apiResults, call.apiResults));
    return fields;
}

export function applyRetainedCompletionFields(event, fields) {
    require(plain(event?.data?.result?.structuredContent) && Array.isArray(event.data.result.structuredContent.results));
    const data = { ...event.data, wireFailureEvidence: fields.wireFailureEvidence,
        result: { ...event.data.result, structuredContent: { ...event.data.result.structuredContent, results: fields.results } } };
    if (fields.wireResultEvidence !== undefined) data.wireResultEvidence = fields.wireResultEvidence;
    else delete data.wireResultEvidence;
    delete data.wireCompletionRef;
    return { ...event, data };
}

export function hydrateCheckpointReferences(checkpoint, { state, dataDir, index, sourceSessionId,
    sourceIdentity = index?.sources?.[sourceSessionId]?.cursor?.identity, records = state.evidence } = {}) {
    const references = validateReferenceCheckpoint(checkpoint, { index, sourceSessionId });
    if (checkpoint.schemaVersion === 2) validateCompletionReferenceFence(index, state, dataDir);
    if (!references.length) return checkpoint.events;
    require(sourceIdentity === checkpoint.cursor.identity);
    require(Array.isArray(records));
    const admitted = filterDeletedRecords(records, state.deletion);
    let bytes = 0;
    const hydrated = new Map();
    for (const event of references) {
        require(filterDeletedEvents([event], sourceSessionId, state.deletion).length === 1);
        const aliases = admitted.filter(record => record.sourceSessionId === sourceSessionId && record.sourceHost === "copilot-app" && !record.sample)
            .flatMap(record => (record.toolCalls ?? []).filter(call => call.toolCallId === event.data.toolCallId));
        require(aliases.length > 0 && aliases.length <= 4);
        let fields;
        for (const call of aliases) {
            require(call.completionEventId === event.id && call.completedAt === event.timestamp
                && ["tool", "startEventId", "startedAt"].every(key => call[key] === aliases[0][key]));
            const next = retainedCompletionFields(call);
            require(!fields || isDeepStrictEqual(fields, next));
            fields = next;
        }
        bytes += Buffer.byteLength(JSON.stringify(fields));
        withinLimit(bytes <= COMPLETION_REFERENCE_LIMITS.hydratedBytes);
        hydrated.set(event.id, applyRetainedCompletionFields(event, fields));
    }
    return checkpoint.events.map(event => hydrated.get(event.id) ?? event);
}

export function referencedCheckpoint(checkpoint, index, sourceSessionId) {
    const next = { ...checkpoint, schemaVersion: 2,
        completionReferences: completionReferenceBinding(index, sourceSessionId, checkpoint.cursor) };
    validateReferenceCheckpoint(next, { index, sourceSessionId });
    return next;
}

export function referenceCheckpointEvent(checkpoint, completionEventId) {
    const matches = checkpoint.events.filter(event => event.id === completionEventId);
    require(matches.length === 1 && matches[0].type === "tool.execution_complete" && matches[0].data?.success === false);
    return { ...checkpoint, events: checkpoint.events.map(event => event === matches[0]
        ? { ...event, data: { ...event.data, wireCompletionRef: 1 } } : event) };
}
