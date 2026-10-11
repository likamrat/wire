// Read-only presentation over the accepted snapshot; never looks up source records.
export function createCallInvestigation() {
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
        const parent = layer === "reported-api"
            ? only(activity?.tool?.filter(call => call.id === row.parentCallId && call.scenarioId === scenario.scenarioId)) : row;
        if (!parent) return unavailable;
        const source = ["tool", "reported-api"].includes(layer)
            ? scenario.toolCalls?.find(call => parent.toolCallId ? call.toolCallId === parent.toolCallId
                : call.startEventId && parent.id === `event:${JSON.stringify([scenario.sourceSessionId, call.startEventId])}`)
            : layer === "http" ? scenario.httpRecords?.find(record => record.recordId === row.recordId)
                : scenario.graphActivities?.find(record => record.activityId === row.activityId);
        return source ? { status: "available", row, source, actionId: parent.id } : unavailable;
    }
    return { duration, order, resolve };
}
