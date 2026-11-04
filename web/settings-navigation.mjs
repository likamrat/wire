// Only fixed setting metadata is searchable here, never local paths or evidence.
export function createSettingsNavigation(search) {
    const categories = [
        { id: "connection", title: "Connection & updates", heading: "connectionTitle" },
        { id: "privacy", title: "Privacy & saved data", heading: "dataManagementTitle" },
        { id: "display", title: "Display", heading: "displayTitle" },
        { id: "troubleshooting", title: "Troubleshooting", heading: "troubleshootingTitle" },
    ];
    const sectionAliases = {
        collection: { section: "connection", setting: "history-window" },
        history: { section: "connection", setting: "history-window" },
        data: { section: "privacy", setting: "delete-activity" },
        evidence: { section: "privacy", setting: "assessment-evidence" },
    };
    const settingAliases = { advanced: "collection-details" };
    const entries = [
        { id: "assessment-evidence", section: "privacy", title: "Save Copilot replies locally", context: "Keep recorded replies with your activity. Turning this off deletes saved response text and dependent retained annotations, not saved reports.", synonyms: "optional evidence answer response capture consent permission revoke", target: "assessmentSetupTitle" },
        { id: "delete-activity", section: "privacy", title: "Review deletion", context: "Preview and permanently delete all collected records or a date range. Saved reports and Copilot sources stay unchanged.", synonyms: "delete collected activity clear remove reset purge records data", target: "deleteActivity" },
        { id: "recollect-activity", section: "privacy", title: "Read history again", context: "Choose chats to preview available history from approved sources. Only explicit confirmation starts recollection.", synonyms: "recollect activity regenerate reread restore deleted history records recovery", target: "recollectActivity" },
        { id: "theme", section: "display", title: "Theme", context: "Choose Light or Dark for this browser. No collection or report content changes.", synonyms: "appearance color light dark contrast", target: "settingsThemePreference" },
        { id: "time-zone", section: "display", title: "Time zone", context: "Choose a city or Device default. Saved reports keep their original time zone.", synonyms: "display timezone local date clock browser reset", target: "displayTimeZone" },
        { id: "source", section: "connection", title: "Review local source & permission", context: "Review GitHub Copilot app metadata and chat log paths before deliberately approving a source.", synonyms: "connect change switch approval database data.db session-state privacy", target: "reviewSource" },
        { id: "microsoft-connection", section: "connection", title: "Microsoft 365 connection", context: "Optional Chat and Cowork connection. Opening this setting does not sign in or change collection.", synonyms: "Microsoft 365 Chat Cowork connect cancel reconnect sign in expiry expired Edge work account", target: "wireMicrosoftConnection" },
        { id: "microsoft-collection", section: "connection", title: "Microsoft collection", context: "Choose Chat, Cowork and history, then explicitly enable collection or save preferences.", synonyms: "Microsoft enable save Chat Cowork sources history collection", target: "nativeCollectionSurfaces" },
        { id: "microsoft-collection-state", section: "connection", title: "Pause or resume Microsoft reads", context: "Change Microsoft reads without changing GitHub preferences or global policy.", synonyms: "Microsoft Chat Cowork stop start pause resume", target: "pauseMicrosoftCollection" },
        { id: "microsoft-collect-now", section: "connection", title: "Collect Microsoft activity", context: "Collect screened Microsoft activity with an original operation receipt. GitHub history is not checked.", synonyms: "Microsoft Chat Cowork collect manual read", target: "collectMicrosoftActivity" },
        { id: "global-collection", section: "connection", title: "Collection across sources", context: "Deliberately pause or allow collection across sources. Manual GitHub Refresh remains separate.", synonyms: "global policy all sources pause resume unset", target: "globalCollectionTitle" },
        { id: "collection-state", section: "connection", title: "Pause or resume collection", context: "Pause or resume new reads without removing retained evidence.", synonyms: "stop start enabled disabled", target: "pauseCollection" },
        { id: "collect-now", section: "connection", title: "Refresh", context: "Update stored activity and check approved history without changing the pause state.", synonyms: "collect now refresh manual run check", target: "checkActivity" },
        { id: "source-paths", section: "connection", title: "Approved source paths", context: "Inspect approved paths or the open source draft. Opening this result changes no permission.", synonyms: "permission database folder directory data.db session-state", target: "approvedSourceDetails" },
        { id: "history-window", section: "connection", title: "History to include", context: "Choose 7, 30 or 90 days of saved history to read. Previously collected evidence stays.", synonyms: "initial history window days range retention import backfill", target: "collectionWindow" },
        { id: "cadence", section: "connection", title: "Check frequency", context: "Choose how often to read new local history entries. Discover chats every 30 seconds.", synonyms: "cadence interval frequency polling seconds events", target: "collectionCadence" },
        { id: "save-preferences", section: "connection", title: "Save preferences", context: "Apply history window and check frequency without changing the source or pause state.", synonyms: "save cancel unsaved preferences cadence", target: "saveCollection" },
        { id: "issues", view: "collection-status", title: "Affected Copilot chats", context: "Open Collection status to find missing, unreadable or limited saved chat history.", synonyms: "missing history gaps issues errors unavailable diagnostics coverage status", target: "collectionIssuesTitle" },
        { id: "collection-details", view: "collection-status", title: "Collection technical details", context: "Open Collection status for last check, source counts and explained reading limits.", synonyms: "diagnostics checked timestamp freshness technical status limits advanced", target: "collectionSetup" },
        { id: "collection-status", view: "collection-status", title: "Collection status", context: "Read current history coverage and connection issues. No source check is started.", synonyms: "troubleshooting health reading status", target: "pageTitle" },
        { id: "network-diagnostic", view: "collection-status", title: "Optional network diagnostic", context: "Read the saved HTTP recorder status. A new public Graph request needs separate confirmation.", synonyms: "http recorder graph test diagnostic", target: "recorderDiagnostics" },
        { id: "service-provenance", section: "troubleshooting", title: "How services are identified", context: "Understand missing or unsupported service targets without guessing which service ran.", synonyms: "service details mapping attribution provenance unknown files tools calls", target: "serviceProvenanceHelp" },
        { id: "author-provenance", section: "troubleshooting", title: "How prompt authors are identified", context: "Understand missing or conflicting sender evidence. The prompt author and tool executor are different.", synonyms: "prompt authors user agent author unverified attribution provenance sender", target: "authorProvenanceHelp" },
        { id: "settings-search", section: "troubleshooting", title: "Missing search results", context: "Find text in saved activity and reports, and understand incomplete results.", synonyms: "search troubleshooting help no matches local text query partial results", target: "settingsSearchDetails" },
    ];
    function resolve(route) {
        let section = route.section || "connection", setting = route.setting, warning = "";
        if (route.issues === "1") setting = "issues";
        else if (Object.hasOwn(sectionAliases, section)) {
            setting ||= sectionAliases[section].setting;
            section = sectionAliases[section].section;
        }
        if (Object.hasOwn(settingAliases, setting)) setting = settingAliases[setting];
        const entry = entries.find(entry => entry.id === setting);
        if (entry?.view === "collection-status" || (!entry && (route.view === "collection-status" || section === "diagnostics"))) {
            return { view: "collection-status", section: undefined, setting: entry?.id,
                warning: setting && !entry ? "Unknown collection detail. Showing Collection status." : "" };
        }
        if (entry) section = entry.section;
        else if (setting) { setting = undefined; warning = "Unknown setting. Showing the category instead."; }
        if (!categories.some(category => category.id === section)) {
            section = "connection";
            warning = "Unknown settings category. Showing Connection & updates.";
        }
        return { section, setting, warning };
    }
    function find(query) {
        if (!query.trim()) return [];
        return entries.map(entry => ({ ...entry, category: entry.view === "collection-status" ? "Collection status" : categories.find(category => category.id === entry.section).title }))
            .filter(entry => search.matches(query, [entry.title, entry.category, entry.context, entry.synonyms]));
    }
    return { categories, entries, sectionAliases, settingAliases, resolve, find };
}
