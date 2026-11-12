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
        if (!value || !["analyze", "trends", "reports", "settings", "collection-status"].includes(value.view)) return null;
        const keys = ["view", "layer", "chart", "bucket", "range", "from", "to", "source", "tool", "services", "includeMissingService",
            "withinServices", "service", "project", "result", "authors", "scope", "endpoint", "session", "page", "expanded",
            "origin", "issues", "section", "setting", "task", "mode", "callSort", "compare", "aFrom", "aTo", "bFrom", "bTo", "comparisonView", "comparisonFocus", "analysisQuery", "search", "inspect", "order", "nativeGroup"];
        const saved = Object.fromEntries(Object.entries(value)
            .filter(([key, entry]) => keys.includes(key) && ["string", "number", "boolean"].includes(typeof entry)));
        if (value.localSearch) saved.localSearch = Object.fromEntries(["settingsSearch", "savedReportSearch", "reportRequestSearch", "issueSearch"]
            .filter(key => typeof value.localSearch[key] === "string").map(key => [key, value.localSearch[key]]));
        if (includeSourceReturn && value.returnToSessions) saved.returnToSessions = returnRoute(value.returnToSessions);
        return savedRoute(canonical(saved));
    }
    // In-memory return routes retain Search; persisted origins carry only page-owned references.
    function encodeHistoryRoute(value, storeAnalysis, includeSourceReturn = false) {
        const route = returnRoute(value, includeSourceReturn);
        if (!route) return null;
        if (Object.hasOwn(route, "analysisQuery")) {
            const query = route.analysisQuery;
            if (typeof query !== "string" || !query.trim()) throw new TypeError("Private Search history requires a nonempty query.");
            delete route.analysisQuery;
            route.analysisKey = storeAnalysis(query);
            if (!/^[a-f0-9-]{36}$/.test(route.analysisKey)) throw new TypeError("Private Search history requires an opaque reference.");
        }
        if (route.returnToSessions) route.returnToSessions = encodeHistoryRoute(route.returnToSessions, storeAnalysis);
        return route;
    }
    function decodeHistoryRoute(value, readAnalysis, includeSourceReturn = false) {
        const route = returnRoute(value, includeSourceReturn);
        if (!route) return null;
        delete route.analysisQuery;
        if (value.analysisKey !== undefined || Object.hasOwn(value, "analysisQuery")) {
            route.analysisQuery = readAnalysis(Object.hasOwn(value, "analysisQuery") ? undefined : value.analysisKey);
        }
        if (includeSourceReturn && value.returnToSessions) route.returnToSessions = decodeHistoryRoute(value.returnToSessions, readAnalysis);
        return route;
    }
    function hasHistoryAnalysis(value) {
        return [value, value?.returnToSessions, value?.returnToResults, value?.returnToResults?.returnToSessions]
            .some(route => route && (route.analysisKey !== undefined || typeof route.analysisQuery === "string"));
    }
    function canonical(route) {
        const overview = ["analyze", "home", "overview", "activity", "calls"].includes(route.view);
        if (!overview && route.view !== "request") {
            const { compare, aFrom, aTo, bFrom, bTo, comparisonView, comparisonFocus, ...peer } = route;
            return peer;
        }
        const { mode, callSort, ...next } = route;
        // A legacy call-page offset is not an interaction-page offset.
        if (route.view === "calls" || mode === "calls" || callSort !== undefined) delete next.page;
        return overview ? { ...next, view: "analyze" } : next;
    }
    function open(route, sessionId, result) {
        if (result) return canonical({ ...route, view: "analyze", session: sessionId, request: undefined, page: undefined, result, origin: undefined });
        const next = { view: "analyze", session: sessionId };
        for (const key of ["layer", "range", "from", "to", "source", "service", "scope", "authors"]) if (route[key]) next[key] = route[key];
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
        for (const key of ["call", "callRevision", "nativeSource", "nativeRevision", "nativeSourceRevision", "nativeOrdinal"]) {
            if (typeof value[key] === "string") origin[key] = value[key];
        }
        return origin;
    }
    return { canonical, open, reportIds, returnRoute, underlying, savedRoute, savedOrigin,
        encodeHistoryRoute, decodeHistoryRoute, hasHistoryAnalysis };
}
