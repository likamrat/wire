// Self-contained for the local browser shell and focused state tests.
export function createSessionJourney() {
    function savedRoute(value) {
        const { bundle, inspect, order, ...route } = value;
        if (route.view !== "reports") return route;
        const valid = id => typeof id === "string" && /^export-[a-f0-9-]{36}$/.test(id);
        if (valid(bundle)) { route.bundle = bundle; delete route.task; }
        else if (valid(inspect) && route.task !== "create") route.inspect = inspect;
        if (order === "oldest") route.order = order;
        return route;
    }
    function returnRoute(value, includeSourceReturn = false) {
        if (!value || !["analyze", "reports", "settings", "collection-status"].includes(value.view)) return null;
        const keys = ["view", "layer", "chart", "bucket", "range", "from", "to", "tool", "services", "includeMissingService",
            "withinServices", "service", "project", "result", "authors", "scope", "endpoint", "session", "page", "expanded",
            "origin", "issues", "section", "setting", "task", "mode", "callSort", "compare", "aFrom", "aTo", "bFrom", "bTo", "search", "inspect", "order"];
        const saved = Object.fromEntries(Object.entries(value)
            .filter(([key, entry]) => keys.includes(key) && ["string", "number", "boolean"].includes(typeof entry)));
        if (value.localSearch) saved.localSearch = Object.fromEntries(["settingsSearch", "savedReportSearch", "reportRequestSearch", "issueSearch"]
            .filter(key => typeof value.localSearch[key] === "string").map(key => [key, value.localSearch[key]]));
        if (includeSourceReturn && value.returnToSessions) saved.returnToSessions = returnRoute(value.returnToSessions);
        return savedRoute(saved);
    }
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
    function underlying(route) {
        if (route.view !== "request") return route;
        return returnRoute(route.returnToResults, true)
            || returnRoute({ ...route, view: route.origin === "reports" ? "reports" : "analyze" }, true);
    }
    function savedOrigin(value) {
        if (value?.view !== "request") return returnRoute(value, true);
        if (typeof value.request !== "string" || !value.request) return null;
        const origin = { ...returnRoute({ ...value, view: "analyze" }, true), view: "request", request: value.request,
            returnToResults: underlying(value) };
        for (const key of ["call", "callRevision"]) if (typeof value[key] === "string") origin[key] = value[key];
        return origin;
    }
    return { canonical, open, reportIds, returnRoute, underlying, savedRoute, savedOrigin };
}
