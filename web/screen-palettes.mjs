import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { screenLight, screenDark } from "./tokens.mjs";
import { harborOutcomeRoles } from "./outcome-paint.mjs";

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
function paint(mode, material, control, status, identity, categories) {
    const surface = parts(["page", "paper", "canvas", "screen-rail", "context-paper", "ink", "muted", "rule", "control", "focus", "hover", "pill-pressed"], material);
    const action = parts(["accent-fill", "on-accent", "primary-hover", "primary-pressed", "accent", "screen-plot", "screen-grid", "screen-tip", "screen-tip-ink"], control);
    const outcomes = parts(["success", "danger", "warning", "unknown", "screen-returned-issue", "tool-positive", "tool-negative", "disclosure-risk", "disclosure-masked"], status);
    const actors = parts(["screen-prompt-user", "screen-prompt-agent", "screen-activity-assistance"], identity);
    const inks = parts(services, categories);
    const harbor = harborOutcomeRoles({ masked: outcomes["disclosure-masked"], negative: outcomes["tool-negative"], returned: outcomes["screen-returned-issue"] }, mode);
    const roles = { ...surface, ...action, ...outcomes, ...actors, ...harbor,
        "navigation-paper": surface["screen-rail"], "floating-paper": surface.paper,
        "surface-edge": surface.rule, "surface-divider": surface.rule, "report-sheet": surface.paper, "report-note": surface.canvas,
        "toggle-on": action["accent-fill"], "toggle-thumb": action["on-accent"], "toggle-off": surface["pill-pressed"],
        "accent-soft": surface["pill-pressed"], "accent-hover": surface.hover, "accent-pressed": surface["pill-pressed"],
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
    midnight: {
        light: paint("light", "#d7e5f2 #fbfdff #e3eef7 #bfd5e8 #f7fbfe #112b43 #203d53 #b7cad6 #54728c #004c73 #ecf2f6 #d8e5ee",
            "#006585 #ffffff #00536f #064860 #285f7e #f5f9fd #7793aa #102f49 #edf8ff",
            "#106143 #9b3046 #745509 #4c5a73 #893f21 #124f42 #8d293c #91304a #245990", "#2e6078 #71506e #85426b",
            "#80511b #245899 #674598 #764473 #1c596c #4c611e #733c82 #345338 #175766 #3f4b83 #515777 #3c595f #32445a #60583c"),
        dark: paint("dark", "#080f1e #172940 #213650 #102035 #182b42 #ebf4ff #d0e4ee #557b94 #94aec4 #aceaff #21364c #2b4055",
            "#55d5f9 #062536 #88e5ff #34bfeb #9ad8f3 #1a2c44 #7898ad #c2eeff #082638",
            "#6cddaf #ff9c9b #efc674 #b4c3dd #f6b08c #88e2ba #ffa69c #ffb2bb #99caff", "#96cce1 #d5b9dd #efa5d7",
            "#ebb681 #8ebeff #c4acfb #e4abda #80c7dc #c6d88c #dcb0ef #9dd5bc #8bced0 #afb8fa #c0c6e1 #a9cdca #d6e0f0 #cfc7ab"),
    },
    petrol: {
        light: screenLight, dark: screenDark,
    },
    linen: {
        light: paint("light", "#e6dfce #fffcf5 #f0e9d9 #d8ccb3 #fdf9f1 #2c2a26 #4c463c #d2c7b7 #72695b #524935 #f5f0e7 #e7decb",
            "#694525 #fff9ed #55371e #3f2a19 #715533 #fbf7ee #93846c #403522 #fff5da",
            "#4d611a #8f254e #855009 #65576a #873b25 #45572b #8a3444 #8a2f44 #26567b", "#26567b #73531e #763963",
            "#78421a #225d72 #634585 #753d67 #224e70 #49571c #703d88 #375333 #245964 #3b4674 #54496b #4d594f #403c45 #5e503b"),
        dark: paint("dark", "#211e19 #353127 #433d31 #2d291f #373328 #f7f2e7 #e5dfd1 #877856 #b6ad99 #eee1c6 #403b30 #4b4335",
            "#e8c486 #322615 #f5d8a2 #cfab70 #e4c78b #38342a #a49a7d #f1ddaf #302216",
            "#b7d575 #f69cbc #edb86a #cac0d3 #f7b190 #c0d393 #f3a7ae #ffafbc #a9cfe9", "#9ac7e6 #e3c88e #f2aee2",
            "#edb58b #82cbd9 #c7aaed #e1a9c8 #a3c9e6 #ccce86 #ddbbea #b3d5ab #a0d4c9 #b5c3f1 #d1c2d9 #b7c8bc #e4dbe9 #d5c69e"),
    },
    blue: {
        light: paint("light", "#dce4f3 #fcfdff #e8edf8 #c6d3ed #f9fbfe #1d304d #2c4167 #bcc9e1 #586e8d #253f67 #eef2f8 #d9e2f0",
            "#183e81 #ffffff #12316c #102956 #345aa0 #f7f9fd #8396b6 #152f54 #f2f6ff",
            "#234fa8 #983d0b #735b05 #4c5a70 #89452a #285a3e #9a343d #9a3045 #284c87", "#1b6275 #675021 #863671",
            "#8a491a #086758 #684291 #754067 #1e5c70 #526216 #713578 #355330 #145269 #284777 #535171 #41565f #303c50 #65604c"),
        dark: paint("dark", "#0f1729 #21304b #2b3e5c #17253c #22324e #edf3ff #d4e0f1 #6178a0 #a3b7d7 #d0e2ff #2c3d58 #344762",
            "#a0c4ff #102442 #bbd5ff #8face6 #a9caff #24344f #90a2c2 #cfdefa #162a45",
            "#8bb5ff #ffad78 #e3cb76 #b4c3df #f1ba9c #a5d8ad #ffaea4 #ffacb8 #add0ff", "#89d4e4 #ddbf7c #efa7d6",
            "#edb190 #80d2ba #d2aeff #efaed5 #8ed3ec #ced791 #d6ace6 #b1d6a5 #96cccc #b1c2ff #c0badc #afc8c0 #d9e3f5 #cfbd9d"),
    },
    field: {
        light: paint("light", "#dee7d4 #fbfdf7 #e8efdf #c8d8b9 #f8fbf3 #263328 #364c3e #bfccbe #60735d #344f39 #eef2ea #dae5d2",
            "#2a503a #f8fff4 #22402f #193325 #416344 #f6faf1 #849778 #253b27 #f3f9e9",
            "#08603b #a03727 #785918 #585968 #863543 #23573e #953b30 #913c40 #28596e", "#34576b #624579 #803969",
            "#83412a #445794 #85500f #713a77 #17596e #486220 #644272 #315438 #255a52 #33476b #525366 #41594b #374337 #5c513e"),
        dark: paint("dark", "#111d16 #25382a #304536 #1d2f22 #273a2c #f1f5ea #d7e4d6 #688260 #a7bda2 #ccdfc6 #304335 #3b4b3a",
            "#a5d19c #182b1e #bbdfae #94b989 #b4d69c #283b2d #95ac90 #d9e8ca #243525",
            "#83d6a5 #f69f86 #e9c678 #c5c6d6 #f6aec4 #9bddb3 #f7aa91 #ffb0aa #a3cfe7", "#9cc8d8 #d6b3e8 #edaed4",
            "#f2ae92 #a7b5ee #e4b782 #d3a6dd #93cddb #d1d991 #cbb6df #afcc9d #91d3c2 #b2c5e0 #c6c1d4 #c0cdbb #e3e8db #cfbf9f"),
    },
};

// An explicit preview scope owns its mode independently of the surrounding screen.
export const paletteTokens = Object.entries(materials).flatMap(([id, modes]) => Object.entries(modes).map(([mode, css]) => {
    const root = `:root[data-evidence-theme=${mode}][data-evidence-palette=${id}]`;
    return `${id === "petrol" ? "" : root + ","}.palette-scene[data-preview-palette=${id}][data-preview-mode=${mode}]{color-scheme:${mode};${css}}`;
})).join("\n");
