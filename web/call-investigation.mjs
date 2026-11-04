// Read-only presentation over the accepted snapshot; never looks up source records.
export function createCallInvestigation(compareEntries) {
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const duration = (row, layer = "tool") => ["tool", "reported-api", "http"].includes(layer)
        && Number.isFinite(row?.durationMs) && row.durationMs >= 0 ? row.durationMs : null;
    function order(rows, sort = "slowest", layer = "tool") {
        return [...rows].sort((a, b) => {
            const left = duration(a, layer), right = duration(b, layer);
            return (left === null ? right === null ? 0 : 1 : right === null ? -1
                : sort === "fastest" ? left - right : right - left) || compare(a.id, b.id);
        });
    }
    const only = values => values?.length === 1 ? values[0] : null;
    function resolve(activity, records, route, revision) {
        if (route.call === undefined) return { status: "none" };
        const unavailable = { status: "unavailable" }, layer = route.layer || "tool";
        // Existing returned-entry IDs contain a canonical offset, not a source event ID.
        if (layer === "reported-api" && (!Number.isSafeInteger(revision) || String(route.callRevision) !== String(revision))) {
            return { ...unavailable, reason: "snapshot-changed" };
        }
        const scenario = only(records.filter(record => record.scenarioId === route.request));
        const row = only(activity?.[layer]?.filter(row => row.id === route.call && row.scenarioId === route.request));
        if (!scenario || !row) return unavailable;
        if (scenario.recordKind === "native-conversation" && layer === "reported-api") {
            const observation = only(scenario.nativeConversation.returnedResults.filter(result => result.observationKey === row.observationKey));
            const source = only(observation?.observed.filter(result => result.index === row.resultIndex));
            if (!source) return unavailable;
            const parent = row.parentCallId === null ? null
                : only(activity.tool?.filter(call => call.id === row.parentCallId && call.scenarioId === scenario.scenarioId));
            if (row.parentCallId !== null && !parent) return unavailable;
            return { status: "available", row, source, actionId: parent?.id ?? row.id,
                nativeResult: { observationKey: row.observationKey, index: row.resultIndex } };
        }
        const parent = layer === "reported-api"
            ? only(activity?.tool?.filter(call => call.id === row.parentCallId && call.scenarioId === scenario.scenarioId)) : row;
        if (!parent) return unavailable;
        const source = ["tool", "reported-api"].includes(layer)
            ? scenario.recordKind === "native-conversation"
                ? scenario.nativeConversation.calls.find(call => call.key === parent.id && call.nativeCallId === parent.toolCallId)
                : scenario.toolCalls?.find(call => parent.toolCallId ? call.toolCallId === parent.toolCallId
                : call.startEventId && parent.id === `event:${JSON.stringify([scenario.sourceSessionId, call.startEventId])}`)
            : layer === "http" ? scenario.httpRecords?.find(record => record.recordId === row.recordId)
                : scenario.graphActivities?.find(record => record.activityId === row.activityId);
        return source ? { status: "available", row, source, actionId: parent.id } : unavailable;
    }
    function firstFailure(activity, records, matching, route, revision) {
        if (route.view !== "request" || route.layer !== "tool" || route.call !== undefined) return null;
        const candidates = [];
        for (const row of matching) {
            if (row.scenarioId !== route.request || row.outcome !== "failure") continue;
            const target = { ...route, call: row.id };
            const resolved = resolve(activity, records, target, revision);
            // Missing ownership cannot be repaired by selecting a neighboring failure.
            if (resolved.status !== "available") return target;
            if (resolved.row.outcome !== "failure") continue;
            const source = records.find(record => record.scenarioId === route.request);
            candidates.push({ target, at: resolved.source.startedAt, index: source.recordKind === "native-conversation"
                ? source.nativeConversation.calls.indexOf(resolved.source) : source.toolCalls.indexOf(resolved.source) });
        }
        candidates.sort((a, b) => compareEntries(a, b) || a.index - b.index);
        return candidates[0]?.target ?? null;
    }
    return { duration, order, resolve, firstFailure };
}
