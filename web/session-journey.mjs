// Self-contained for the local browser shell and focused state tests.
export function createSessionJourney() {
    function canonical(route) {
        if (!["analyze", "home", "overview", "activity", "calls"].includes(route.view)) return route;
        return { ...route, view: "analyze", ...(route.view === "calls" ? { mode: "calls" } : {}) };
    }
    function open(route, sessionId, result) {
        if (result) return { ...route, view: "analyze", mode: "calls", session: sessionId, request: undefined, page: undefined, result, origin: undefined };
        const next = { view: "analyze", session: sessionId };
        for (const key of ["layer", "range", "from", "to", "service", "scope", "authors"]) if (route[key]) next[key] = route[key];
        return next;
    }
    function reportIds(catalog, sessionId) {
        if (!Array.isArray(catalog?.requests) || catalog.requests.some(request => !request.sourceSessionId || !request.scenarioId)) return null;
        return [...new Set(catalog.requests.filter(request => request.sourceSessionId === sessionId).map(request => request.scenarioId))];
    }
    return { canonical, open, reportIds };
}
