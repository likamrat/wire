export function createReportScope(authorship) {
    const countKeys = ["workIqActions", "returnedApiResults", "graphRequestSites", "graphVisibleStatuses", "ownedHttpRecords", "graphCodeReferences"];
    const nativeKeys = ["calls", "returnedResults", "messages", "parts", "taskStates"];
    const native = request => request.recordKind === "native-conversation";
    const plural = (n, unit) => `${n.toLocaleString()} ${unit}${n === 1 ? "" : "s"}`;
    return {
        inclusion(value) {
            if (!value.available) return "Report selection unavailable";
            if (value.nativeConversations) return `One report with ${plural(value.nativeConversations, "Microsoft conversation")}${value.githubRequestGroups ? ` and ${plural(value.githubRequestGroups, "GitHub request group")}` : ""} included`;
            return value.requests.length ? `One report with ${plural(value.requests.length, "request group")} included`
                : value.authorExcludedRequestGroups ? "No requests match the report's prompt authors" : "No requests selected";
        },
        resolve(catalog, kind, currentIds, selectedIds, authorSelection) {
            if (authorSelection !== undefined && (!authorship || !authorship.validSelection(authorSelection))) throw new TypeError("Choose supported report prompt authors.");
            const ids = kind === "all" ? null : [...new Set(kind === "current" ? currentIds : selectedIds)];
            const requested = ids && new Set(ids);
            const promptAuthors = authorship?.selection(authorSelection);
            const baseRequests = (catalog?.requests || []).filter(r => !requested || r.aliases.some(id => requested.has(id)));
            const requests = baseRequests.filter(request => native(request) || !promptAuthors || promptAuthors.includes(request.promptAuthor ?? "unknown"));
            const nativeRequests = requests.filter(native), githubRequests = requests.filter(request => !native(request));
            const issue = nativeRequests.length && promptAuthors && promptAuthors.length !== authorship.actors.length
                ? "Choose all prompt authors for a native report; a native conversation has no single qualified originating author." : "";
            const sourceSessionIds = requests.map(request => request.sourceSessionId);
            const sourceSessionCount = Array.isArray(catalog?.requests) && sourceSessionIds.every(id => typeof id === "string" && id.length > 0)
                ? new Set(sourceSessionIds).size : null;
            const counts = Object.fromEntries(countKeys.map((key) => [key, githubRequests.every(r => Number.isSafeInteger(r.counts?.[key]) && r.counts[key] >= 0) ? githubRequests.reduce((n, r) => n + r.counts[key], 0) : null]));
            const nativeCounts = Object.fromEntries(nativeKeys.map(key => [key, nativeRequests.every(request =>
                Number.isSafeInteger(request.nativeCounts?.[key]) && request.nativeCounts[key] >= 0)
                ? nativeRequests.reduce((sum, request) => sum + request.nativeCounts[key], 0) : null]));
            return {
                requests, baseRequests, counts, ids, promptAuthors, sourceSessionCount, authorExcludedRequestGroups: baseRequests.length - requests.length,
                nativeConversations: nativeRequests.length, githubRequestGroups: githubRequests.length, nativeCounts, issue,
                available: Boolean(catalog) && !issue && [...Object.values(counts), ...Object.values(nativeCounts)].every(value => value !== null),
                excludedRequestedGroups: ids?.filter(id => !baseRequests.some(request => request.aliases.includes(id))).length || 0,
                selection: revision => ({ kind, revision, ...(ids ? { scenarioIds: ids } : {}),
                    ...(authorSelection !== undefined ? { promptAuthors } : {}) }),
            };
        },
        summary(value) {
            if (value.issue) return value.issue;
            if (!value.available) return "Report result counts are unavailable. Refresh before previewing; missing counts are not zero.";
            const c = value.counts;
            if (!value.requests.length) return value.authorExcludedRequestGroups
                ? `None of the ${plural(value.baseRequests.length, "request group")} in this scope match the prompt authors. Your base selection is kept; change the author choice to include them.`
                : "No requests selected. Select interactions in Analyze or deliberately choose Current view or All collected activity.";
            const narrowed = value.authorExcludedRequestGroups ? `${value.requests.length.toLocaleString()} of ${plural(value.baseRequests.length, "request group")} match the prompt authors` : plural(value.githubRequestGroups ?? value.requests.length, "request group");
            const github = `${narrowed}: ${plural(c.workIqActions, "Work IQ tool call")}, ${plural(c.returnedApiResults, "tool-returned API result")}, ${plural(c.graphRequestSites, "recorded Graph request site")} (${c.graphVisibleStatuses.toLocaleString()} with visible status), ${plural(c.ownedHttpRecords, "owned HTTP record")}, ${plural(c.graphCodeReferences, "Graph code reference")}.`;
            const n = value.nativeCounts;
            const microsoft = value.nativeConversations ? `${plural(value.nativeConversations, "Microsoft conversation")}: ${plural(n.calls, "native call")}, ${plural(n.returnedResults, "returned-result observation")}, ${plural(n.messages, "message representation")}, ${plural(n.parts, "message part")}, ${plural(n.taskStates, "task-state observation")}.` : "";
            return [microsoft, !value.nativeConversations || value.githubRequestGroups ? github : "", "These are separate units, not a combined total."].filter(Boolean).join(" ");
        },
    };
}
