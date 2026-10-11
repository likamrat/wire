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
 --page:#f2f3f3;--paper:#fcfcfc;--canvas:#e9ebeb;--hover:#dfe2e2;
 --ink:#252a2e;--muted:#505b60;--rule:#cbd0d1;--control:#717b80;
 --copilot-chat-title:#6b4e8c;
 --accent:#176676;--accent-soft:#dcebed;--accent-fill:#236875;--on-accent:#f9fcfc;
 --accent-hover:#1b5a65;--accent-pressed:#154c55;
 --pill-outline:var(--control);--pill-hover:var(--hover);--pill-pressed:#d1d6d7;
 --danger:#a12f5a;--success:#236849;--warning:#765900;--unknown:#58656e;
 --performance-red:#9b3750;--performance-orange:#88501c;--performance-gold:#6a610b;--performance-teal:#22675f;
 --delete-fill:#a12f5a;--delete-ink:#ffffff;
 --chart-success:#22685e;--chart-failure:#a03461;--chart-partial:#87521d;--chart-unknown:#58656e;
 --focus:#176676;--scrim:#17191ca6;--shadow:none;
`;
const dark = `
 color-scheme:dark;
 --page:#17191c;--paper:#202327;--canvas:#2a2e32;--hover:#34393e;
 --ink:#edf0f2;--muted:#b4bdc4;--rule:#474e54;--control:#929fa8;
 --copilot-chat-title:#c6b0dd;
 --accent:#83c9cf;--accent-soft:#293f43;--accent-fill:#8ac9cd;--on-accent:#14282b;
 --accent-hover:#a0d4d7;--accent-pressed:#b5dfe1;
 --pill-outline:var(--control);--pill-hover:var(--hover);--pill-pressed:#41474c;
 --danger:#e8a0b7;--success:#97cbb1;--warning:#d8bb79;--unknown:#b3bdc5;
 --performance-red:#e6a2b3;--performance-orange:#ddba96;--performance-gold:#d3c780;--performance-teal:#94c7bf;
 --delete-fill:#e8a0b7;--delete-ink:#311d24;
 --chart-success:#94c7bf;--chart-failure:#e3a0bb;--chart-partial:#dcb789;--chart-unknown:#b3bdc5;
 --focus:#9cdae0;--scrim:#101214bd;--shadow:none;
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
