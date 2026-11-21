export const uxIconSources = Object.freeze({
    copy: "copy", check: "check", warning: "triangle-alert", unobserved: "circle-question-mark", info: "info", account: "user-round",
    "result-failure": "circle-x", "result-partial": "circle-dashed", "result-other": "info", "result-transport": "unplug",
    "check-compact": "check", "result-failure-compact": "circle-x", "unobserved-compact": "circle-question-mark",
    "result-partial-compact": "circle-dashed", "result-other-compact": "info", "result-transport-compact": "unplug",
    "select-check": "check", sun: "sun", moon: "moon", chevron: "chevron-down", disclosure: "chevron-right",
    pending: "loader-circle", "pending-small": "loader-circle",
    home: "house", activity: "rotate-ccw-clock", reports: "file-text", settings: "settings", "collection-status": "file-search",
    "home-selected": "house", "activity-selected": "rotate-ccw-clock", "reports-selected": "file-text",
    "settings-selected": "settings", "collection-status-selected": "file-search",
    export: "file-output", menu: "menu", "navigation-home": "house", "navigation-analyze": "chart-column",
    "navigation-reports": "clipboard-list", "navigation-settings": "settings", "navigation-help": "circle-question-mark",
    "navigation-trends": "chart-no-axes-combined",
    "navigation-records": "rotate-ccw-clock", "navigation-compare": "scale", "navigation-create-report": "file-text",
    "navigation-collapse": "panel-left", "navigation-expand": "panel-left",
    "activity-panel": "panel-right-open", "activity-panel-close": "panel-right-close",
    "search-analysis": "chart-no-axes-combined",
    "search-interaction": "message-square", "search-context": "messages-square", "search-reply": "message-square-reply",
    "search-action": "workflow", "search-tool": "wrench",
    "search-report": "file-text", "search-comparison": "columns-2", "search-view": "panels-top-left", "search-setting": "settings",
    "compare-periods": "scale",
    "report-all": "layers", "report-agent": "bot",
    "report-files": "files", "report-options": "ellipsis", "report-masked": "shield-check",
    "report-original": "shield-alert", "report-no-text": "message-square-off",
    "settings-connection": "clock", "settings-source-access": "plug", "settings-privacy": "shield", "settings-ai": "clipboard-check",
    "settings-themes": "palette", "settings-regional": "globe", "settings-general": "settings", "settings-troubleshooting": "circle-question-mark",
    close: "x", back: "arrow-left", refresh: "refresh-cw", reset: "rotate-ccw", download: "download", code: "file-code",
    "zoom-in": "plus", "zoom-out": "minus",
    "reader-maximize": "maximize-2", "reader-restore": "minimize-2",
    "chart-collapse": "chevron-up",
    calendar: "calendar-days",
    search: "search", filter: "funnel", clock: "clock", "time-zone": "globe", connection: "plug", database: "database",
    read: "eye", tree: "list-tree", hide: "eye-off", previous: "chevron-left", next: "chevron-right", forward: "arrow-right",
    "collapse-sections": "fold-vertical", "expand-sections": "unfold-vertical",
});

export const serviceIconSources = Object.freeze({
    Mail: "mail", Calendar: "calendar", Files: "folder", Teams: "users-round",
    People: "user-round", Tasks: "list-todo", Notes: "notebook", Directory: "network",
    Search: "search", Discovery: "book-open", "Multiple workloads": "grid-2x2", "Platform metadata": "code-xml",
    Unknown: "circle-question-mark", "group:other": "layout-grid", Assistance: "message-circle",
});

export function iconSize(role) {
    return role.startsWith("navigation-") || role.startsWith("settings-") || role === "search-analysis" ? 24
        : role.startsWith("search-") || role.endsWith("-compact") || ["info", "chevron", "disclosure", "select-check", "pending-small"].includes(role) ? 16 : 20;
}

// Lucide's canonical names have changed since the family shipped in React Icons.
const aliases = { "circle-question-mark": "LuCircleHelp", "rotate-ccw-clock": "LuHistory", funnel: "LuFilter", "grid-2x2": "LuGrid2X2" };
export const componentName = slug => aliases[slug] ?? "Lu" + slug.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join("");

export function iconProps(role, name, size) {
    return {
        xmlns: "http://www.w3.org/2000/svg", className: "wire-icon", size,
        "data-lucide-icon": name, "data-icon-size": size, "data-icon-role": role,
        "aria-hidden": true, focusable: false,
    };
}
