import { createHash } from "node:crypto";

export const deletionHash = value => createHash("sha256").update(value).digest("hex");
export const LOCAL_DELETION_IDENTITY_VERSION = 2;
const identity = (kind, ...parts) => deletionHash(JSON.stringify([kind, ...parts]));
const present = value => typeof value === "string" && value.length > 0;
export const eventIdentity = (source, eventId) => identity("event", source, eventId);
export const callIdentity = (source, callId) => identity("call", source, callId);
export function activityDeletionVersion(state) {
    const epoch = state.deletion?.epoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError("Invalid activity deletion epoch.");
    return Math.max(epoch, Object.values(state.deletion?.operations ?? {}).filter(operation => operation.kind !== "artifact-deletion").length);
}
export const artifactDeletionKey = (kind, bundleId) => identity("saved-artifact", kind, bundleId);
const mutableLocalFields = new Set([
    "order", "parentToolCallId", "parallelGroup", "fallback", "evidenceRefs",
    "completionEventId", "completedAt", "durationMs", "toolSucceeded", "reportedOutcome",
    "apiResults", "httpStatus", "status", "statusBasis", "transportError",
    "observedGraphHttp", "evidenceLevel", "model", "modelSource",
]);
function canonicalLocalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalLocalValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined).map(key => [key, canonicalLocalValue(value[key])]));
    return value;
}
function localIdentity(record, family, item) {
    const stable = Object.fromEntries(Object.entries(item).filter(([key]) => !mutableLocalFields.has(key)));
    // Anonymous retained copies have no trustworthy ordinal after pruning. Their
    // start/request fingerprint stays stable through completion and link cleanup.
    const startedAt = family === "graphActivities" ? item.startedAt : item.startedAt ?? record.capturedAt;
    return identity("local-v2", record.scenarioId, family, startedAt ?? null, canonicalLocalValue(stable));
}

export function filterDeletedEvents(events, source, deletion) {
    if (!deletion) return events;
    const ids = new Set(deletion.events ?? []), calls = new Set(deletion.contextCalls ?? []);
    return events.flatMap(event => {
        if (ids.has(eventIdentity(source, event.id))) {
            // Preserve the prompt boundary, never its deleted text, for genuinely new calls.
            return event.type === "user.message" ? [{ id: event.id, type: event.type, timestamp: event.timestamp, data: { content: null } }] : [];
        }
        if (event.data?.toolCallId && calls.has(callIdentity(source, event.data.toolCallId))) return [];
        return [event];
    });
}

export function recordUnits(record) {
    const source = record.sourceSessionId ?? null;
    const units = [];
    for (const [family, items] of Object.entries({
        toolCalls: record.toolCalls ?? [], graphActivities: record.graphActivities ?? [], httpRecords: record.httpRecords ?? [],
    })) items.forEach((item, index) => {
        if (family === "toolCalls" && item.tool === "owned-graph-http" && record.httpRecords?.length) return;
        const aliases = family === "toolCalls" && present(source) ? [
            present(item.toolCallId) && identity("call", source, item.toolCallId),
            present(item.startEventId) && identity("start", source, item.startEventId),
        ].filter(Boolean) : family === "graphActivities" && present(item.activityId) ? [identity("graph", source, item.activityId)]
            : family === "httpRecords" && present(item.recordId) ? [identity("http", item.recordId)] : [];
        const local = !aliases.length;
        if (local) aliases.push(localIdentity(record, family, item));
        units.push({ record, family, item, index, aliases, local, at: family === "graphActivities" ? item.startedAt : item.startedAt ?? record.capturedAt });
    });
    if (!units.length) units.push({ record, family: "empty", item: record, aliases: [identity("empty", record.scenarioId)], at: record.capturedAt });
    return units;
}

export function filterDeletedRecords(records, deletion) {
    if (!deletion) return records;
    const blocked = new Set(deletion.identities ?? []);
    const deletedEvents = new Set(deletion.events ?? []);
    const cleanPrompt = (prompt, record) => prompt?.sourceEventId && deletedEvents.has(eventIdentity(record.sourceSessionId, prompt.sourceEventId))
        && !recordUnits(record).some(unit => unit.aliases.some(alias =>
            deletion.promptAuthorizations?.[eventIdentity(record.sourceSessionId, prompt.sourceEventId)]?.includes(alias)))
        ? { ...prompt, text: null, status: "unavailable" } : prompt;
    function cleanRelations(record) {
        const deletedCall = id => id && blocked.has(callIdentity(record.sourceSessionId, id));
        const cleanParent = item => deletedCall(item.parentToolCallId) ? { ...item, parentToolCallId: null } : item;
        return { ...record,
            ...(record.responseTiming && (record.assessmentMembershipPruned
                || [record.responseTiming.promptEventId, record.responseTiming.finalEventId, record.responseTiming.completionEventId]
                    .some(id => id && deletedEvents.has(eventIdentity(record.sourceSessionId, id))))
                ? { responseTiming: { schemaVersion: 1, status: "unavailable", reason: "deleted-timing-dependency" } } : {}),
            ...(record.toolCalls ? { toolCalls: record.toolCalls.map(cleanParent) } : {}),
            ...(record.graphActivities ? { graphActivities: record.graphActivities.map(activity => {
                const next = cleanParent(activity);
                const preceding = activity.fallback?.precedingWorkIqCallIds;
                const retained = preceding?.filter(id => !deletedCall(id));
                const refs = activity.evidenceRefs?.filter(ref => !deletedEvents.has(eventIdentity(record.sourceSessionId, ref.eventId)));
                return { ...next,
                    ...(preceding && retained.length !== preceding.length ? { fallback: {
                        ...activity.fallback, precedingWorkIqCallIds: retained,
                        association: retained.length ? activity.fallback.association : "none",
                    } } : {}),
                    ...(refs && refs.length !== activity.evidenceRefs.length ? { evidenceRefs: refs } : {}),
                };
            }) } : {}),
        };
    }
    return records.flatMap(record => {
        const units = recordUnits(record);
        const matchedLocal = new Set();
        for (const unit of units) if (unit.local && unit.aliases.some(id => blocked.has(id))) {
            const key = unit.aliases[0];
            if (matchedLocal.has(key)) {
                throw Object.assign(new Error("Multiple anonymous records share an indistinguishable local identity. Nothing was deleted; an explicit stable source identity is required to safely select these records."), {
                    code: "AMBIGUOUS_LOCAL_DELETION_IDENTITY",
                });
            }
            matchedLocal.add(key);
        }
        if (units.some(unit => unit.local && blocked.has(identity("local", record.scenarioId, unit.family, unit.index)))) {
            throw Object.assign(new Error("Older positional local-deletion markers cannot safely identify this retained record. Nothing was reimported or additionally deleted; inspect the prior local deletion before continuing."), {
                code: "LEGACY_LOCAL_DELETION_IDENTITY",
            });
        }
        const removed = units.filter(unit => unit.aliases.some(id => blocked.has(id)));
        if (!removed.length) return [cleanRelations({
            ...record, ...(record.userPrompt !== undefined ? { userPrompt: cleanPrompt(record.userPrompt, record) } : {}),
            ...(record.followUpPrompts ? { followUpPrompts: record.followUpPrompts.map(prompt => cleanPrompt(prompt, record)) } : {}),
        })];
        const next = { ...record, assessmentMembershipPruned: true };
        for (const family of ["toolCalls", "graphActivities", "httpRecords"]) {
            if (!record[family]) continue;
            const indices = new Set(removed.filter(unit => unit.family === family).map(unit => unit.index));
            next[family] = record[family].filter((_, index) => !indices.has(index));
        }
        if (record.httpRecords?.length && !next.httpRecords.length) next.toolCalls = (next.toolCalls ?? []).filter(call => call.tool !== "owned-graph-http");
        if (next.userPrompt !== undefined) next.userPrompt = cleanPrompt(next.userPrompt, next);
        if (next.followUpPrompts) next.followUpPrompts = next.followUpPrompts.map(prompt => cleanPrompt(prompt, next));
        return (next.toolCalls?.length || next.graphActivities?.length || next.httpRecords?.length) ? [cleanRelations(next)] : [];
    });
}
