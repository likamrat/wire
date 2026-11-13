import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Preserve the official 24-unit geometry; display size belongs to the role.
export function lucideIcon(name, size = 20) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || ![16, 20, 24].includes(size)) {
        throw new TypeError("Lucide icons require an asset name and a 16, 20 or 24 pixel display size.");
    }
    const svg = readFileSync(require.resolve(`lucide-static/icons/${name}.svg`), "utf8");
    return svg.slice(svg.indexOf("<svg"))
        .replace(/class="[^"]*"/, `class="wire-icon" data-lucide-icon="${name}" data-icon-size="${size}" aria-hidden="true" focusable="false"`)
        .replace('width="24"', `width="${size}"`).replace('height="24"', `height="${size}"`);
}

export const lucideLicense = readFileSync(require.resolve("lucide-static/LICENSE"), "utf8");

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
    "navigation-reports": "clipboard-list", "navigation-settings": "settings",
    "navigation-trends": "chart-no-axes-combined",
    "navigation-records": "rotate-ccw-clock", "navigation-compare": "scale", "navigation-create-report": "file-text",
    "navigation-collapse": "panel-left", "navigation-expand": "panel-left",
    "search-analysis": "chart-no-axes-combined",
    "search-interaction": "message-square", "search-context": "messages-square", "search-reply": "message-square-reply",
    "search-action": "workflow", "search-tool": "wrench",
    "search-report": "file-text", "search-comparison": "columns-2", "search-view": "panels-top-left", "search-setting": "settings",
    "compare-periods": "scale",
    "report-all": "layers", "report-agent": "bot",
    "report-files": "files", "report-options": "ellipsis", "report-masked": "shield-check",
    "report-original": "shield-alert", "report-no-text": "message-square-off",
    "settings-connection": "plug", "settings-privacy": "shield", "settings-ai": "clipboard-check",
    "settings-display": "monitor", "settings-troubleshooting": "wrench",
    close: "x", back: "arrow-left", refresh: "refresh-cw", reset: "rotate-ccw", download: "download", code: "file-code",
    "zoom-in": "plus", "zoom-out": "minus",
    "reader-maximize": "maximize-2", "reader-restore": "minimize-2",
    "chart-collapse": "chevron-up",
    search: "search", filter: "funnel", clock: "clock", "time-zone": "globe", connection: "plug", database: "database",
    read: "eye", tree: "list-tree", hide: "eye-off", previous: "chevron-left", next: "chevron-right", forward: "arrow-right",
    "collapse-sections": "fold-vertical", "expand-sections": "unfold-vertical",
});

export const uxIcons = Object.freeze(Object.fromEntries(Object.entries(uxIconSources).map(([role, asset]) => [
    role, lucideIcon(asset, role.startsWith("navigation-") || role.startsWith("settings-") || role === "search-analysis" ? 24
        : role.startsWith("search-") || role.endsWith("-compact") || ["info", "chevron", "disclosure", "select-check", "pending-small"].includes(role) ? 16 : 20),
])));
