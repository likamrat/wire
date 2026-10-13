import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Keep the official path geometry and optical size; only add presentation semantics.
export function fluentIcon(name, size = 20, variant = "regular") {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || ![16, 20, 24].includes(size) || !["regular", "filled"].includes(variant)) throw new TypeError("Fluent icons require a package glyph name, a 16, 20 or 24 pixel optical size, and a regular or filled variant.");
    const asset = `${name}_${size}_${variant}`;
    const svg = readFileSync(require.resolve(`@fluentui/svg-icons/icons/${asset}.svg`), "utf8");
    return svg.replace("<svg ", `<svg class="fluent-icon" data-fluent-icon="${asset}" aria-hidden="true" focusable="false" fill="currentColor" `);
}

export const uxIconSources = Object.freeze({
    copy: "copy_20_regular",
    check: "checkmark_20_regular",
    warning: "warning_20_regular",
    unobserved: "question_circle_20_regular",
    info: "info_16_regular",
    "result-failure": "dismiss_circle_20_regular",
    "result-partial": "circle_half_fill_20_regular",
    "result-other": "info_20_regular",
    "result-transport": "plug_disconnected_20_regular",
    "check-compact": "checkmark_16_regular",
    "result-failure-compact": "dismiss_circle_16_regular",
    "unobserved-compact": "question_circle_16_regular",
    "result-partial-compact": "circle_half_fill_16_regular",
    "result-other-compact": "info_16_regular",
    "result-transport-compact": "plug_disconnected_16_regular",
    "select-check": "checkmark_16_regular",
    sun: "weather_sunny_20_regular",
    moon: "weather_moon_20_regular",
    chevron: "chevron_down_16_regular",
    disclosure: "chevron_right_16_regular",
    pending: "spinner_ios_20_regular",
    "pending-small": "spinner_ios_16_regular",
    home: "home_20_regular",
    activity: "history_20_regular",
    reports: "document_bullet_list_20_regular",
    settings: "settings_20_regular",
    "collection-status": "document_search_20_regular",
    "home-selected": "home_20_filled",
    "activity-selected": "history_20_filled",
    "reports-selected": "document_bullet_list_20_filled",
    "settings-selected": "settings_20_filled",
    "collection-status-selected": "document_search_20_filled",
    export: "arrow_export_ltr_20_regular",
    menu: "navigation_20_regular",
    "navigation-home": "home_24_regular",
    "navigation-analyze": "data_trending_24_regular",
    "navigation-reports": "document_24_regular",
    "navigation-settings": "settings_24_regular",
    "navigation-collapse": "panel_left_contract_24_regular",
    "navigation-expand": "panel_left_expand_24_regular",
    "settings-connection": "plug_connected_24_regular",
    "settings-privacy": "shield_24_regular",
    "settings-ai": "clipboard_task_24_regular",
    "settings-display": "desktop_24_regular",
    "settings-troubleshooting": "wrench_24_regular",
    close: "dismiss_20_regular",
    refresh: "arrow_clockwise_20_regular",
    reset: "arrow_reset_24_regular",
    download: "arrow_download_20_regular",
    search: "search_20_regular",
    clock: "clock_20_regular",
    "time-zone": "globe_clock_20_regular",
    connection: "plug_connected_20_regular",
    database: "database_20_regular",
});

// MIT-licensed Fluent System Icons are read at startup, never fetched by the browser.
export const uxIcons = Object.freeze(Object.fromEntries(Object.entries(uxIconSources).map(([key, asset]) => {
    const [, name, size, variant] = /^(.*)_(16|20|24)_(regular|filled)$/.exec(asset);
    return [key, fluentIcon(name, Number(size), variant)];
})));
