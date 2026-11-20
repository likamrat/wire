import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { screenLight, screenDark } from "./tokens.mjs";

// Screen paint only. Service IDs and outcome meanings belong to the shared projection;
// never pass this catalog to a report writer or use a color to classify a record.
const servicePalette = createDimensionalCharts().servicePalette;
const services = ["Mail","Calendar","Files","Teams","People","Tasks","Notes","Directory","Search","Discovery",
    "Multiple workloads","Platform metadata","Unknown","group:other"].map(id => servicePalette[id].token);
if (Object.keys(servicePalette).length !== services.length) throw Error("Missing screen palette for a service");
const parts = (names, colors) => {
    const values = colors.split(" ");
    if (names.length !== values.length || values.some(value => !/^#[a-f0-9]{6}$/.test(value))) throw Error("Incomplete screen palette");
    return Object.fromEntries(names.map((name, i) => [name, values[i]]));
};
function paint(material, control, status, identity, categories) {
    const surface = parts(["page", "paper", "canvas", "screen-rail", "ink", "muted", "rule", "control", "focus", "hover", "pill-pressed"], material);
    const action = parts(["accent-fill", "on-accent", "primary-hover", "primary-pressed", "accent", "screen-plot", "screen-grid", "screen-tip", "screen-tip-ink"], control);
    const outcomes = parts(["success", "danger", "warning", "unknown", "screen-returned-issue"], status);
    const actors = parts(["screen-prompt-user", "screen-prompt-agent", "screen-activity-assistance"], identity);
    const inks = parts(services, categories);
    const roles = { ...surface, ...action, ...outcomes, ...actors,
        "navigation-paper": surface.page, "context-paper": surface.canvas, "floating-paper": surface.paper,
        "surface-edge": surface.rule, "surface-divider": surface.rule, "report-sheet": surface.paper, "report-note": surface.canvas,
        "toggle-on": action["accent-fill"], "toggle-thumb": action["on-accent"], "toggle-off": surface["pill-pressed"],
        "accent-soft": surface.hover, "accent-hover": surface.hover, "accent-pressed": surface["pill-pressed"],
        "delete-fill": outcomes.danger, "delete-ink": action["on-accent"], "copilot-chat-title": inks["service-teams"],
        "performance-red": outcomes.danger, "performance-orange": outcomes["screen-returned-issue"], "performance-gold": outcomes.warning, "performance-teal": outcomes.success,
        "screen-service-files": inks["service-files"], "chart-success": outcomes.success, "chart-failure": outcomes.danger,
        "screen-success-high": outcomes.success, "screen-success-low": outcomes.success, "screen-failure-high": outcomes.danger, "screen-failure-low": outcomes.danger,
        "chart-partial": outcomes.warning, "chart-unknown": outcomes.unknown,
        "chart-mark-high": action.accent, "chart-mark-low": action.accent,
        "search-ring-start": inks["service-calendar"], "search-ring-middle": actors["screen-prompt-agent"], "search-ring-end": inks["service-teams"], "search-ring-focus": surface.focus,
    };
    for (const [token, ink] of Object.entries({ ...inks, violet: inks["service-other"] })) {
        for (const face of ["label", "top", "mid", "base", "side", "cap"]) roles[`chart-${token}-${face}`] = ink;
    }
    // Preserve the existing series assignment; never choose a series color from its value.
    const series = [inks["service-calendar"], inks["service-files"], actors["screen-prompt-agent"], outcomes.warning,
        inks["service-teams"], inks["service-tasks"], inks["service-people"], inks["service-discovery"],
        inks["service-mail"], inks["service-notes"], outcomes.danger, inks["service-multiple"]];
    series.forEach((v, i) => { roles[`trends-series-${i + 1}`] = v; });
    ["interaction", "context", "reply", "action", "tool", "service", "report", "comparison", "view", "setting"].forEach((v,i) => { roles[`search-${v}`] = series[i]; });
    return Object.entries(roles).map(([name,value]) => `--${name}:${value};`).join("");
}
const materials = {
    petrol: {
        light: `${screenLight}--screen-rail:#e4ecec;--screen-plot:#f5f8f8;`,
        dark: `${screenDark}--screen-rail:#26383c;--screen-plot:#222e32;`,
    },
    linen: {
        light: paint("#eae5da #fffdf7 #f5f0e5 #e6dbc5 #2c2a26 #59554d #d3c9b6 #80786b #524935 #f0eadc #e5ddcb",
            "#694525 #fff9ed #55371e #3f2a19 #694019 #faf1dc #756d58 #403522 #fff5da",
            "#4d611a #8f254e #855009 #65576a #873b25", "#26567b #73531e #763963",
            "#78421a #225d72 #634585 #753d67 #224e70 #49571c #703d88 #375333 #245964 #3b4674 #54496b #4d594f #403c45 #5e503b"),
        dark: paint("#211f1c #2c2a26 #37342e #40392b #f7f2e7 #ccc6b8 #555044 #a69f90 #eee1c6 #413d34 #4c473c",
            "#e8c486 #322615 #f5d8a2 #cfab70 #f0d09a #373122 #a49a7d #f1ddaf #302216",
            "#b7d575 #f69cbc #edb86a #cac0d3 #f7b190", "#9ac7e6 #e3c88e #f2aee2",
            "#edb58b #82cbd9 #c7aaed #e1a9c8 #a3c9e6 #ccce86 #ddbbea #b3d5ab #a0d4c9 #b5c3f1 #d1c2d9 #b7c8bc #e4dbe9 #d5c69e"),
    },
    blue: {
        light: paint("#e3eaf7 #fbfcff #edf2fb #cbd9ef #1d304d #465a76 #bac9de #667995 #253f67 #e6edf9 #d7e3f5",
            "#183e81 #ffffff #12316c #102956 #164989 #e8efff #5a7190 #152f54 #f2f6ff",
            "#234fa8 #983d0b #735b05 #4c5a70 #89452a", "#1b6275 #675021 #863671",
            "#8a491a #086758 #684291 #754067 #1e5c70 #526216 #713578 #355330 #145269 #284777 #535171 #41565f #303c50 #65604c"),
        dark: paint("#111a2b #1c2a41 #27344e #273d60 #edf3ff #b6c8e5 #455671 #94accd #d0e2ff #293d5c #324969",
            "#a0c4ff #102442 #bbd5ff #8face6 #a7cdff #202e4c #90a2c2 #cfdefa #162a45",
            "#8bb5ff #ffad78 #e3cb76 #b4c3df #f1ba9c", "#89d4e4 #ddbf7c #efa7d6",
            "#edb190 #80d2ba #d2aeff #efaed5 #8ed3ec #ced791 #d6ace6 #b1d6a5 #96cccc #b1c2ff #c0badc #afc8c0 #d9e3f5 #cfbd9d"),
    },
    field: {
        light: paint("#e6ebdf #fcfdf7 #eff3e7 #d2dfc2 #263328 #495e4a #bfccb7 #697b64 #344f39 #e6eddf #d7e3cc",
            "#2a503a #f8fff4 #22402f #193325 #29563b #eaf1de #67785c #253b27 #f3f9e9",
            "#08603b #a03727 #785918 #585968 #863543", "#34576b #624579 #803969",
            "#83412a #445794 #85500f #713a77 #17596e #486220 #644272 #315438 #255a52 #33476b #525366 #41594b #374337 #5c513e"),
        dark: paint("#172019 #222e25 #2b382d #304733 #f1f5ea #c0d0bf #485949 #95ab92 #ccdfc6 #344437 #3c503d",
            "#a5d19c #182b1e #bbdfae #94b989 #b4dea8 #263728 #95ac90 #d9e8ca #243525",
            "#83d6a5 #f69f86 #e9c678 #c5c6d6 #f6aec4", "#9cc8d8 #d6b3e8 #edaed4",
            "#f2ae92 #a7b5ee #e4b782 #d3a6dd #93cddb #d1d991 #cbb6df #afcc9d #91d3c2 #b2c5e0 #c6c1d4 #c0cdbb #e3e8db #cfbf9f"),
    },
};

// An explicit preview scope owns its mode independently of the surrounding screen.
export const paletteTokens = Object.entries(materials).flatMap(([id, modes]) => Object.entries(modes).map(([mode, css]) => {
    const root = `:root[data-evidence-theme=${mode}][data-evidence-palette=${id}]`;
    return `${id === "petrol" ? "" : root + ","}.palette-scene[data-preview-palette=${id}][data-preview-mode=${mode}]{color-scheme:${mode};${css}}`;
})).join("\n") + `
@media(forced-colors:none) {
 :root[data-evidence-palette]:not([data-evidence-palette=petrol]) {
   .chart-panel,.percentage-card,.trends-plot {background:var(--screen-plot)}
   .trends-grid {stroke:var(--screen-grid)}
   .wire-search-panel {--wire-search-match:var(--accent)}
   .ux-tooltip {background:var(--screen-tip);color:var(--screen-tip-ink)}
   .returned-issue-ink,.reader-returned-cue {color:var(--screen-returned-issue)}
 }
}`;
