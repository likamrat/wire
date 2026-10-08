// Self-contained for the local browser shell and focused state tests.
export function createSessionJourney() {
    function open(route, sessionId, result) {
        if (result) return { ...route, view: "activity", session: sessionId, request: undefined, page: undefined, result, origin: undefined };
        const next = { view: "activity", session: sessionId };
        for (const key of ["layer", "range", "from", "to", "service", "scope", "authors"]) if (route[key]) next[key] = route[key];
        return next;
    }
    function reportIds(catalog, sessionId) {
        if (!Array.isArray(catalog?.requests) || catalog.requests.some(request => !request.sourceSessionId || !request.scenarioId)) return null;
        return [...new Set(catalog.requests.filter(request => request.sourceSessionId === sessionId).map(request => request.scenarioId))];
    }
    return { open, reportIds };
}
