// Only fixed setting metadata is searchable here, never local paths or evidence.
export function createSettingsNavigation(search) {
    const categories = [
        { id: "display", title: "Time zone", heading: "displayTitle" },
        { id: "connection", title: "Connection & permission", heading: "connectionTitle" },
        { id: "collection", title: "Collection preferences", heading: "preferencesTitle" },
        { id: "data", title: "Data management", heading: "dataManagementTitle" },
    ];
    const entries = [
        { id: "automatic-scores", section: "collection", title: "Automatic scores", context: "Approve specific chats, evidence and a shared model allowance. Separate from saving replies locally.", synonyms: "accuracy trust evaluation scoring model budget credits automatic", target: "automaticScoresTitle" },
        { id: "assessment-evidence", section: "collection", title: "Save Copilot replies locally", context: "Keep recorded replies with your activity. Off until you turn it on.", synonyms: "optional evidence answer response assessment insights capture consent permission revoke", target: "assessmentSetupTitle" },
        { id: "delete-activity", section: "data", title: "Delete collected activity", context: "Preview and permanently delete all collected records or a date range. Saved reports and Copilot sources stay unchanged.", synonyms: "clear delete remove reset purge records data", target: "deleteActivity" },
        { id: "recollect-activity", section: "data", title: "Recollect activity", context: "Read available activity again from approved Copilot chats.", synonyms: "recollect regenerate reread restore deleted history records", target: "recollectActivity" },
        { id: "time-zone", section: "display", title: "Time zone", context: "Choose a city or Device default. Saved reports keep their original time zone.", synonyms: "display timezone local date clock browser reset", target: "displayTimeZone" },
        { id: "source", section: "connection", title: "Review local source & permission", context: "Review Copilot metadata and chat log paths before deliberately approving a source.", synonyms: "connect change switch approval database data.db session-state privacy", target: "reviewSource" },
        { id: "collection-state", section: "connection", title: "Pause or resume collection", context: "Keep retained evidence and the approved source when pausing or resuming.", synonyms: "stop start enabled disabled", target: "pauseCollection" },
        { id: "collect-now", section: "connection", title: "Refresh", context: "Update stored activity and check approved history without changing the pause state.", synonyms: "collect now refresh manual run check", target: "checkActivity" },
        { id: "source-paths", section: "connection", title: "Approved source paths", context: "Inspect the local metadata and chat log paths this app may read.", synonyms: "permission database folder directory data.db session-state", target: "approvedSourceDetails" },
        { id: "history-window", section: "collection", title: "Initial history window", context: "Choose 7, 30 or 90 days of saved history to read. Previously collected evidence stays.", synonyms: "history days range retention import backfill", target: "collectionWindow" },
        { id: "cadence", section: "collection", title: "Check frequency", context: "Choose how often to read new local history entries. Discover chats every 30 seconds.", synonyms: "cadence interval frequency polling seconds events", target: "collectionCadence" },
        { id: "save-preferences", section: "collection", title: "Save preferences", context: "Apply history window and check frequency without changing the source or pause state.", synonyms: "save cancel unsaved preferences cadence", target: "saveCollection" },
        { id: "issues", view: "collection-status", title: "Affected Copilot chats", context: "Open Collection status to find missing, unreadable or limited saved chat history.", synonyms: "missing history gaps issues errors unavailable diagnostics coverage status", target: "collectionIssuesTitle" },
        { id: "collection-details", view: "collection-status", title: "Collection technical details", context: "Open Collection status for last check, source counts and explained reading limits.", synonyms: "diagnostics checked timestamp freshness technical status limits advanced", target: "collectionSetup" },
    ];
    function resolve(route) {
        let section = route.section || "connection", setting = route.setting, warning = "";
        if (route.issues === "1") setting = "issues";
        else if (section === "history") { section = "collection"; setting ||= "history-window"; }
        else if (section === "evidence") { section = "collection"; setting ||= "assessment-evidence"; }
        if (setting === "advanced") setting = "collection-details";
        const entry = entries.find(entry => entry.id === setting);
        if (entry?.view === "collection-status" || (!entry && (route.view === "collection-status" || section === "diagnostics"))) {
            return { view: "collection-status", section: undefined, setting: entry?.id,
                warning: setting && !entry ? "Unknown collection detail. Showing Collection status." : "" };
        }
        if (entry) section = entry.section;
        else if (setting) { setting = undefined; warning = "Unknown setting. Showing the category instead."; }
        if (!categories.some(category => category.id === section)) {
            section = "connection";
            warning = "Unknown settings category. Showing Connection & permission.";
        }
        return { section, setting, warning };
    }
    function find(query) {
        if (!query.trim()) return [];
        return entries.map(entry => ({ ...entry, category: entry.view === "collection-status" ? "Collection status" : categories.find(category => category.id === entry.section).title }))
            .filter(entry => search.matches(query, [entry.title, entry.category, entry.context, entry.synonyms]));
    }
    return { categories, entries, resolve, find };
}
