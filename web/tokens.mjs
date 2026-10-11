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
 --tracking-heading:.015em;--tracking-ui:0;
 --weight-regular:400;--weight-medium:500;--weight-strong:700;
`;

const light = `
 color-scheme:light;
 --page:#f4f5f9;--paper:#ffffff;--canvas:#eceef5;--hover:#e3e7f0;
 --ink:#222635;--muted:#515767;--rule:#cdd2df;--control:#6f788a;
 --copilot-chat-title:#6842ba;
 --accent:#006580;--accent-soft:#e0f1f6;--accent-fill:#006580;--on-accent:#ffffff;
 --accent-hover:#cfe8f0;--accent-pressed:#bddfe9;
 --pill-outline:var(--control);--pill-hover:var(--hover);--pill-pressed:#d8deea;
 --danger:#a52b75;--success:#007458;--warning:#815200;--unknown:#586071;
 --performance-red:#9f2d68;--performance-orange:#8a451c;--performance-gold:#706000;--performance-teal:#006e5d;
 --delete-fill:#a52b75;--delete-ink:#ffffff;
 --chart-success:#007458;--chart-failure:#a52b75;--chart-partial:#815200;--chart-unknown:#586071;
 --focus:#006580;--scrim:#0e101ca6;--shadow:none;
`;
const dark = `
 color-scheme:dark;
 --page:#0f111a;--paper:#171923;--canvas:#141622;--hover:#232735;
 --ink:#f7f7f7;--muted:#a8acba;--rule:#272a3d;--control:#747d92;
 --copilot-chat-title:#ad88f0;
 --accent:#06b6d4;--accent-soft:#102c37;--accent-fill:#06b6d4;--on-accent:#0f111a;
 --accent-hover:#123542;--accent-pressed:#183e4d;
 --pill-outline:var(--control);--pill-hover:var(--hover);--pill-pressed:#2c3142;
 --danger:#ed58a5;--success:#10b981;--warning:#f59e0b;--unknown:#a2a9b9;
 --performance-red:#ed58a5;--performance-orange:#efa15d;--performance-gold:#d5c541;--performance-teal:#10b981;
 --delete-fill:#ed58a5;--delete-ink:#250b1b;
 --chart-success:#10b981;--chart-failure:#ed58a5;--chart-partial:#f59e0b;--chart-unknown:#a2a9b9;
 --focus:#06b6d4;--scrim:#090b16bd;--shadow:none;
`;

export const tokens = `
:root {
 ${light}
 ${typographyTokens}
 --layer-header:3;--layer-tooltip:4;--layer-skip:5;
 --space-xs:4px;--space-sm:8px;--space-md:12px;--space-lg:16px;--space-xl:24px;--space-2xl:32px;--space-3xl:48px;
 --radius:6px;--radius-small:6px;--radius-dialog:8px;--radius-pill:999px;--radius-primary:6px;--radius-control:6px;--radius-field:4px;
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
