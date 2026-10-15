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
    copy: "copy", check: "check", warning: "triangle-alert", unobserved: "circle-question-mark", info: "info",
    "result-failure": "circle-x", "result-partial": "circle-dashed", "result-other": "info", "result-transport": "unplug",
    "check-compact": "check", "result-failure-compact": "circle-x", "unobserved-compact": "circle-question-mark",
    "result-partial-compact": "circle-dashed", "result-other-compact": "info", "result-transport-compact": "unplug",
    "select-check": "check", sun: "sun", moon: "moon", chevron: "chevron-down", disclosure: "chevron-right",
    pending: "loader-circle", "pending-small": "loader-circle",
    home: "house", activity: "rotate-ccw-clock", reports: "file-text", settings: "settings", "collection-status": "file-search",
    "home-selected": "house", "activity-selected": "rotate-ccw-clock", "reports-selected": "file-text",
    "settings-selected": "settings", "collection-status-selected": "file-search",
    export: "file-output", menu: "menu", "navigation-home": "house", "navigation-analyze": "chart-no-axes-combined",
    "navigation-reports": "file-text", "navigation-settings": "settings",
    "navigation-collapse": "panel-left-close", "navigation-expand": "panel-left-open",
    "settings-connection": "plug", "settings-privacy": "shield", "settings-ai": "clipboard-check",
    "settings-display": "monitor", "settings-troubleshooting": "wrench",
    close: "x", back: "arrow-left", refresh: "refresh-cw", reset: "rotate-ccw", download: "download",
    search: "search", clock: "clock", "time-zone": "globe", connection: "plug", database: "database",
    read: "eye", hide: "eye-off", previous: "chevron-left", next: "chevron-right", forward: "arrow-right",
});

export const uxIcons = Object.freeze(Object.fromEntries(Object.entries(uxIconSources).map(([role, asset]) => [
    role, lucideIcon(asset, role.startsWith("navigation-") || role.startsWith("settings-") ? 24
        : role.endsWith("-compact") || ["info", "chevron", "disclosure", "select-check", "pending-small"].includes(role) ? 16 : 20),
])));
