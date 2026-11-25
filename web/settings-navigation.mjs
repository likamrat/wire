// Only fixed setting metadata is searchable here, never local paths or evidence.
export function createSettingsNavigation(search, { updates = true } = {}) {
    const categories = [
        ...(updates ? [{ id: "general", title: "General", heading: "generalTitle" }] : []),
        { id: "connection", title: "Collection", heading: "connectionTitle" },
        { id: "source-access", title: "Source access", heading: "sourceAccessTitle" },
        { id: "themes", title: "Themes", heading: "themesTitle" },
        { id: "regional", title: "Regional", heading: "regionalTitle" },
        { id: "privacy", title: "Privacy & saved data", heading: "dataManagementTitle" },
        { id: "analyze", title: "Analyze", heading: "analyzeSettingsTitle", group: "defaults" },
        { id: "trends", title: "Trends", heading: "trendsSettingsTitle", group: "defaults" },
        { id: "reports", title: "Reports", heading: "reportsSettingsTitle", group: "defaults" },
        { id: "compare", title: "Compare", heading: "compareSettingsTitle", group: "defaults" },
    ];
    const sectionAliases = {
        ...(updates ? { updates: { section: "general" } } : {}),
        display: { section: "themes" },
        theme: { section: "themes" },
        collection: { section: "connection", setting: "history-window" },
        history: { section: "connection", setting: "history-window" },
        data: { section: "privacy", setting: "delete-activity" },
        evidence: { section: "privacy", setting: "assessment-evidence" },
    };
    const settingAliases = { advanced: "collection-details" };
    const entries = [
        ...(updates ? [
            { id: "app-update", section: "general", title: "Check for WIRE updates", context: "Check for a newer build from main. Checking does not install it.", synonyms: "version application upgrade manual release", target: "appUpdateCheck" },
            { id: "automatic-updates", section: "general", title: "Automatically check for updates", context: "Check on opening WIRE and daily while it stays open. You choose when to install.", synonyms: "automatic update checks preferences enable disable scheduled", target: "appUpdateAuto" },
        ] : []),
        { id: "analyze-range", section: "analyze", title: "Default date range", context: "Choose All dates, Last 7 days, Last 14 days or Last 30 days for a fresh Analyze view.", synonyms: "date range when opening Analyze starting period filter", target: "defaultAnalyzeRange" },
        { id: "analyze-layout", section: "analyze", title: "Homepage layout", context: "Reorder Analyze widgets and Interactions or restore the original layout.", synonyms: "position placement move arrange cards charts tokens usage first last", target: "analyzeLayout" },
        { id: "analyze-sort", section: "analyze", title: "Default interaction sort", context: "Start with the most recent interactions or those with the most tokens.", synonyms: "usage order sort", target: "defaultAnalyzeSort" },
        { id: "guide-start", section: "analyze", title: "Open Guide to", context: "Start with recorded outcomes or the last topic read in this tab.", synonyms: "chart guide topic reader starting topic", target: "defaultGuideStart" },
        { id: "hidden-cards", section: "analyze", title: "Keep hidden cards out of view", context: "Choose how long future cards stay hidden.", synonyms: "hide restore tab privacy duration", target: "defaultCardHideDuration" },
        { id: "trend-chart", section: "trends", title: "Default trend chart", context: "Choose the first chart on opening Trends. Direct chart links keep their measure.", synonyms: "homepage errors failures tool calls usage services call duration prompt authors response models", target: "defaultTrendChart" },
        { id: "report-formats", section: "reports", title: "Default file formats", context: "Choose the file formats preselected for each new report.", synonyms: "HTML PDF Markdown JSON export save", target: "defaultFormat-html" },
        { id: "report-period", section: "reports", title: "Default reporting period", context: "Choose how many days a new report includes, ending today.", synonyms: "dates range last 7 14 30", target: "defaultReportPeriod" },
        { id: "comparison-period", section: "compare", title: "Default comparison period", context: "Compare the last complete days with the preceding period of equal length.", synonyms: "date range new comparison 7 14 30", target: "defaultCompareDays" },
        { id: "assessment-evidence", section: "privacy", title: "Save Copilot replies locally", context: "Keep recorded replies with your activity. Turning this off deletes saved response text and dependent retained annotations, not saved reports.", synonyms: "optional evidence answer response capture consent permission revoke", target: "assessmentSetupTitle" },
        { id: "delete-activity", section: "privacy", title: "Review deletion", context: "Preview and permanently delete all collected records or a date range. Saved reports and Copilot sources stay unchanged.", synonyms: "delete collected activity clear remove reset purge records data", target: "deleteActivity" },
        { id: "recollect-activity", section: "privacy", title: "Read history again", context: "Choose chats to preview available history from approved sources. Only explicit confirmation starts recollection.", synonyms: "recollect activity regenerate reread restore deleted history records recovery", target: "recollectActivity" },
        { id: "theme", section: "themes", title: "Appearance mode", context: "Choose Light or Dark for this browser. No collection or report content changes.", synonyms: "display theme color light dark contrast", target: "settingsThemePreference" },
        { id: "palette", section: "themes", title: "Color palette", context: "Change screen and widget colors for this browser. Saved reports are unchanged.", synonyms: "display appearance theme colour petrol coral linen graphite blueprint field notes midnight", target: "palette-petrol" },
        { id: "time-zone", section: "regional", title: "Time zone", context: "Choose a city or Device default. Saved reports keep their original time zone.", synonyms: "display timezone local date clock browser reset", target: "displayTimeZone" },
        { id: "source", section: "source-access", title: "Review local source & permission", context: "Review GitHub Copilot app metadata and chat log paths before deliberately approving a source.", synonyms: "connect change switch approval database data.db session-state privacy", target: "reviewSource" },
        { id: "microsoft-connection", section: "connection", title: "Microsoft 365 connection", context: "Optional Chat and Cowork connection. Opening this setting does not sign in or change collection.", synonyms: "Microsoft 365 Chat Cowork connect cancel reconnect sign in expiry expired Edge work account", target: "wireMicrosoftConnection" },
        { id: "microsoft-collection", section: "connection", title: "Microsoft collection", context: "Choose Chat, Cowork and history, then explicitly enable collection or save preferences.", synonyms: "Microsoft enable save Chat Cowork sources history collection", target: "nativeCollectionSurfaces" },
        { id: "microsoft-collection-state", section: "connection", title: "Pause or resume Microsoft reads", context: "Change Microsoft reads without changing GitHub preferences or global policy.", synonyms: "Microsoft Chat Cowork stop start pause resume", target: "pauseMicrosoftCollection" },
        { id: "microsoft-collect-now", section: "connection", title: "Collect Microsoft activity", context: "Collect screened Microsoft activity with an original operation receipt. GitHub history is not checked.", synonyms: "Microsoft Chat Cowork collect manual read", target: "collectMicrosoftActivity" },
        { id: "global-collection", section: "connection", title: "Collection across sources", context: "Deliberately pause or allow collection across sources. Manual GitHub Refresh remains separate.", synonyms: "global policy all sources pause resume unset", target: "globalCollectionTitle" },
        { id: "collection-state", section: "connection", title: "Pause or resume collection", context: "Pause or resume new reads without removing retained evidence.", synonyms: "stop start enabled disabled", target: "pauseCollection" },
        { id: "collect-now", section: "connection", title: "Refresh", context: "Update stored activity and check approved history without changing the pause state.", synonyms: "collect now refresh manual run check", target: "checkActivity" },
        { id: "source-paths", section: "source-access", title: "Approved source paths", context: "Inspect approved paths or the open source draft. Opening this result changes no permission.", synonyms: "permission database folder directory data.db session-state", target: "approvedSourceDetails" },
        { id: "history-window", section: "connection", title: "History to include", context: "Choose 7, 30 or 90 days of saved history to read. Previously collected evidence stays.", synonyms: "initial history window days range retention import backfill", target: "collectionWindow" },
        { id: "cadence", section: "connection", title: "Check frequency", context: "Choose how often to read new local history entries. Discover chats every 30 seconds.", synonyms: "cadence interval frequency polling seconds events", target: "collectionCadence" },
        { id: "save-preferences", section: "connection", title: "Save preferences", context: "Apply history window and check frequency without changing the source or pause state.", synonyms: "save cancel unsaved preferences cadence", target: "saveCollection" },
        { id: "issues", view: "collection-status", title: "Affected Copilot chats", context: "Open Collection status to find missing, unreadable or limited saved chat history.", synonyms: "missing history gaps issues errors unavailable diagnostics coverage status", target: "collectionIssuesTitle" },
        { id: "collection-details", view: "collection-status", title: "Collection technical details", context: "Open Collection status for last check, source counts and explained reading limits.", synonyms: "diagnostics checked timestamp freshness technical status limits advanced", target: "collectionSetup" },
        { id: "collection-status", view: "collection-status", title: "Collection status", context: "Read current history coverage and connection issues. No source check is started.", synonyms: "troubleshooting health reading status", target: "pageTitle" },
        { id: "network-diagnostic", view: "collection-status", title: "Optional network diagnostic", context: "Read the saved HTTP recorder status. A new public Graph request needs separate confirmation.", synonyms: "http recorder graph test diagnostic", target: "recorderDiagnostics" },
    ];
    function resolve(route) {
        let section = route.section || categories[0].id, setting = route.setting, warning = "";
        if (updates && section === "release-notes") return { view:"settings", section, warning };
        if (route.issues === "1") setting = "issues";
        else if (Object.hasOwn(sectionAliases, section)) {
            setting ||= sectionAliases[section].setting;
            section = sectionAliases[section].section;
        }
        if (Object.hasOwn(settingAliases, setting)) setting = settingAliases[setting];
        const entry = entries.find(entry => entry.id === setting);
        const oldHelp = { "activity-counts": "counts", "recorded-results": "results", "service-provenance": "results", "author-provenance": "results", "settings-search": "history" };
        if (!entry && (section === "troubleshooting" || section === "help" || Object.hasOwn(oldHelp, setting)))
            return { view: "help", section: Object.hasOwn(oldHelp, setting) ? oldHelp[setting] : "reports", warning: "" };
        if (entry?.view === "collection-status" || (!entry && (route.view === "collection-status" || section === "diagnostics"))) {
            return { view: "collection-status", section: undefined, setting: entry?.id,
                warning: setting && !entry ? "Unknown collection detail. Showing Collection status." : "" };
        }
        if (entry) section = entry.section;
        else if (setting) { setting = undefined; warning = "Unknown setting. Showing the category instead."; }
        if (!categories.some(category => category.id === section)) {
            section = "connection";
            warning = "Unknown settings category. Showing Collection.";
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
