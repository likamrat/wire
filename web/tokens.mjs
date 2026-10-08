import { uiFontStack } from "../lib/typeface.mjs";

export const typographyTokens = `
 --font:${uiFontStack};
 --mono:"Cascadia Mono","Cascadia Code",Consolas,"SFMono-Regular",Menlo,monospace;
 --type-caption:.75rem;--type-small:.875rem;--type-body:.875rem;--type-reading:1rem;--type-control:.875rem;
 --type-title:1.5rem;--type-section:1.125rem;--type-brand:1.125rem;--type-metric:2.25rem;
 --type-dialog:1.375rem;--type-data-value:1.375rem;--type-score:3rem;
 --leading-ui:1.4285714286;--leading-control:1.4285714286;--leading-caption:1.3333333333;
 --leading-reading:1.625;--leading-heading:1.3333333333;--leading-section:1.3333333333;
 --leading-dialog:1.35;--leading-data-value:1.35;
 --tracking-heading:0;--tracking-ui:0;
 --weight-regular:400;--weight-medium:500;--weight-strong:600;
`;

const light = `
 color-scheme:light;
 --page:#f3f6fb;--paper:#fcfdff;--canvas:#eaf0f7;--hover:#e1eaf5;
 --ink:#1b2d45;--muted:#50647b;--rule:#ced9e6;--control:#71849a;
 --copilot-chat-title:#62458a;
 --accent:#255ea8;--accent-soft:#e1edfc;--accent-fill:#285fa5;--on-accent:#f9fcff;
 --pill-outline:#63758d;--pill-hover:#e1eaf5;--pill-pressed:#ced9e6;
 --danger:#b43848;--success:#216748;--warning:#815900;--unknown:#63738a;
 --performance-red:#a72d3e;--performance-orange:#914400;--performance-gold:#756000;--performance-teal:#17685e;
 --delete-fill:#a52638;--delete-ink:#ffffff;
 --chart-success:#4878b4;--chart-failure:#b84658;--chart-partial:#896315;--chart-unknown:#6f7c8f;
 --focus:#255ea8;--scrim:#182f5099;--shadow:0 12px 36px #233e5e14;
`;
const dark = `
 color-scheme:dark;
 --page:#142236;--paper:#1b2e46;--canvas:#233a55;--hover:#2e4867;
 --ink:#ecf3fd;--muted:#b2c2d5;--rule:#405773;--control:#8ca1bc;
 --copilot-chat-title:#dfc5ff;
 --accent:#9ac2f5;--accent-soft:#2c486a;--accent-fill:#9ac2f5;--on-accent:#142b49;
 --pill-outline:#8ca1bc;--pill-hover:#2e4867;--pill-pressed:#36516f;
 --danger:#ffadb6;--success:#92d5b2;--warning:#efc57e;--unknown:#b2bfd1;
 --performance-red:#ffadb6;--performance-orange:#ffc28a;--performance-gold:#eed17d;--performance-teal:#91d6cb;
 --delete-fill:#ffadb6;--delete-ink:#301820;
 --chart-success:#85b2eb;--chart-failure:#ed9aa6;--chart-partial:#e1bd79;--chart-unknown:#afbdd0;
 --focus:#b2d3ff;--scrim:#0d1b30b8;--shadow:0 16px 40px #0e1c3033;
`;

export const tokens = `
:root {
 ${light}
 ${typographyTokens}
 --layer-header:3;--layer-tooltip:4;--layer-skip:5;
 --space-xs:4px;--space-sm:8px;--space-md:12px;--space-lg:16px;--space-xl:24px;--space-2xl:32px;--space-3xl:48px;
 --radius:20px;--radius-small:8px;--radius-dialog:24px;--radius-pill:999px;--radius-primary:8px;--radius-control:8px;--radius-field:4px;
 --pill-fill:var(--paper);--pill-ink:var(--ink);--pill-border:var(--pill-outline);
 --pill-height:44px;--pill-inset:12px;--pill-gap:8px;--pill-weight:var(--weight-medium);
 --icon-size:20px;--icon-size-small:16px;
 --help-target:max(var(--pill-height),1.5rem);--help-gap:var(--space-xs);--help-icon:1rem;--tooltip-gap:var(--space-sm);
}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) {${dark}}
}
:root[data-evidence-theme=light] {${light}}
:root[data-evidence-theme=dark] {${dark}}
`;
