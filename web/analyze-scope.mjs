// Serialized with the shell. Read accepted state only; this module owns no filters.
export function createAnalyzeScope(results, authorship, serviceLabel, sourceLabel) {
    const collections = { history: "Saved collection", legacy: "Earlier snapshot", all: "Both collections" };
    function format({ applied, acceptedRoute, period, analytics, snapshot, hasSearch = false }, pairedScope) {
        const paired = pairedScope !== undefined;
        const filters = applied.filters;
        if (!Object.hasOwn(collections, filters.scope)) throw new RangeError("Accepted collection scope is unavailable.");
        if (filters.outcomes?.some(value => !Object.hasOwn(results.labels(applied.layer), value))) {
            throw new RangeError("Accepted outcome scope is unavailable.");
        }
        const parts = paired ? [] : [period, collections[filters.scope]];
        const restrictions = [];
        if (!paired && (filters.from || filters.to)) restrictions.push(period);
        if (filters.scope !== "history") {
            restrictions.push(collections[filters.scope]);
            if (paired) parts.push(collections[filters.scope]);
        }
        let activeCount = Number(!paired && Boolean(filters.from || filters.to)) + Number(filters.scope !== "history");
        function add(label, values, restriction = true) {
            if (!values?.length) return;
            const text = `${label}: ${values.join(", ")}`;
            if (!paired || restriction) parts.push(text);
            if (restriction) restrictions.push(text);
            activeCount++;
        }
        const count = value => value.toLocaleString(applied.timeContext?.locale);
        if (applied.layer !== "tool") add("Activity", [results.unit(applied.layer, 2)], false);
        if (filters.sources?.length && typeof sourceLabel !== "function") throw new TypeError("Accepted source presentation is unavailable.");
        add("Source", filters.sources?.map(id => sourceLabel(id)));
        if (acceptedRoute.nativeGroupLabel) add("Microsoft group", [acceptedRoute.nativeGroupLabel]);
        add("Tool", filters.tools);
        if (filters.services?.length) {
            const selection = paired ? null : analytics.serviceInvolvement?.selection;
            if (!paired && (!selection || !Array.isArray(selection.knownMatchIds) || !Array.isArray(selection.contextOnlyIds)
                || selection.includeMissingService !== (filters.includeMissingService === true))) {
                throw new TypeError("Accepted service selection is unavailable.");
            }
            add("Service", [filters.services.map(serviceLabel).join(", ") + (filters.includeMissingService ? ""
                : paired ? " only" : ` only (${count(selection.knownMatchIds.length)} known matches)`)]);
            if (filters.includeMissingService) {
                const context = paired ? "Missing-service context allowed"
                    : `Includes missing-service context: ${count(selection.knownMatchIds.length)} known matches; ${count(selection.contextOnlyIds.length)} context-only`;
                parts.push(context); restrictions.push(context);
                activeCount++;
            }
        }
        add("Category", filters.workloads?.map(serviceLabel));
        if (applied.layer === "code-reference") {
            add("Previous outcome", filters.outcomes?.map(value => `${results.labels("tool")[value]} (execution not observed)`));
        } else add("Outcome", filters.outcomes?.map(value => results.labels(applied.layer)[value]));
        if (authorship.filterValue(filters.promptAuthors)) add("Author", [authorship.selectionLabel(filters.promptAuthors)]);
        add("Copilot project", filters.projectIds?.map(id => id === null ? "Project not recorded"
            : (paired ? pairedScope.projects.find(entry => entry.id === id)?.name : snapshot.scenarios.find(scenario => scenario.projectId === id)?.project) || "Project unavailable"));
        add(applied.layer === "http" ? "Recorder source" : "Copilot chat", filters.sourceSessionIds?.map(id => (paired
            ? pairedScope.sessions.find(entry => entry.id === id)?.name : snapshot.sessions?.find(source => source.sessionId === id)?.name
                || snapshot.scenarios.find(scenario => scenario.sourceSessionId === id)?.sourceSessionName) || (applied.layer === "http" ? "Source unavailable" : "Chat unavailable")));
        add("API path", filters.endpoints?.map(id => (paired ? pairedScope.endpoints.find(entry => entry.id === id)?.name
            : analytics.filterOptions?.endpoints?.find(entry => entry.id === id)?.label) || "Selected path unavailable"));
        for (const service of acceptedRoute.withinServices?.split(",") || []) {
            const context = `${serviceLabel(service)} within current scope`;
            parts.push(context); restrictions.push(context);
            activeCount++;
        }
        if (hasSearch) { parts.push("Search applied"); restrictions.push("Search applied"); activeCount++; }
        return { text: parts.join("; "), parts, activeCount, restrictions, restrictionText: restrictions.join("; ") };
    }
    function describePair(pair) {
        if (pair === null) return null;
        const value = pair?.comparison, scope = pair?.scope;
        if (typeof pair?.key !== "string" || !pair.key || !Number.isSafeInteger(pair.revision) || pair.revision < 0 || pair.revision !== value?.revision
            || value?.kind !== "retained-period-comparison" || value.schemaVersion !== 1
            || !value.options?.filters || value.options.filters.from !== undefined || value.options.filters.to !== undefined
            || !Array.isArray(value.selection?.withinServices) || typeof scope?.hasSearch !== "boolean"
            || !["projects", "sessions", "endpoints"].every(key => Array.isArray(scope[key])
                && scope[key].every(entry => entry && typeof entry.id === "string" && (entry.name === null || typeof entry.name === "string")))) {
            throw new TypeError("Accepted comparison scope is unavailable.");
        }
        return format({ applied: value.options, acceptedRoute: { withinServices: value.selection.withinServices.join(",") || undefined },
            hasSearch: scope.hasSearch }, scope);
    }
    return { describe: input => format(input), describePair };
}
