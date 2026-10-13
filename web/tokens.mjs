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
 --danger:#a52b75;--success:#007458;--warning:#a14d16;--unknown:#586071;
 --performance-red:#9f2d68;--performance-orange:#8a451c;--performance-gold:#706000;--performance-teal:#006e5d;
 --delete-fill:#a52b75;--delete-ink:#ffffff;
 --chart-success:#086d7c;--chart-failure:#a14d16;--chart-partial:#95552a;--chart-unknown:#586071;
 --chart-mark-high:#007f9b;--chart-mark-low:#23509a;--chart-fade-strength:82%;
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
 --danger:#ed58a5;--success:#10b981;--warning:#f2a262;--unknown:#a2a9b9;
 --performance-red:#ed58a5;--performance-orange:#efa15d;--performance-gold:#d5c541;--performance-teal:#10b981;
 --delete-fill:#ed58a5;--delete-ink:#250b1b;
 --chart-success:#48bfd2;--chart-failure:#f2a262;--chart-partial:#e59b76;--chart-unknown:#a2a9b9;
 --chart-mark-high:#48bfd2;--chart-mark-low:#4279b7;--chart-fade-strength:65%;
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

// Screen surfaces are separate from the tokens embedded in saved reports and PDFs.
const screenLight = `
 --page:#f1f3f7;--paper:#ffffff;--canvas:#ebebeb;--hover:#e3e3e3;
 --surface-shadow:0 2px 4px #26344d0a,0 8px 20px #26344d0a;
 --ink:#202020;--muted:#565656;--rule:#c9c9c9;--control:#747474;
 --accent:#303030;--accent-soft:#e9e9e9;--accent-fill:#303030;--on-accent:#ffffff;
 --accent-hover:#dedede;--accent-pressed:#d5d5d5;--pill-pressed:#d9d9d9;
 --danger:#b3261e;--delete-fill:#b3261e;--delete-ink:#ffffff;--performance-red:#b3261e;
 --chart-failure:#b3261e;--screen-failure-high:#c23c32;--screen-failure-low:#9f2922;
 --screen-prompt-user:#365f7a;
 --focus:#303030;--scrim:#000000a6;
`;
const screenDark = `
 --page:#101010;--paper:#191919;--canvas:#222222;--hover:#2b2b2b;
 --surface-shadow:0 2px 4px #00000029,0 8px 20px #00000029;
 --ink:#f2f2f2;--muted:#b8b8b8;--rule:#444444;--control:#888888;
 --accent:#e0e0e0;--accent-soft:#2b2b2b;--accent-fill:#e0e0e0;--on-accent:#191919;
 --accent-hover:#333333;--accent-pressed:#3b3b3b;--pill-pressed:#353535;
 --danger:#f28b82;--delete-fill:#f28b82;--delete-ink:#281210;--performance-red:#f28b82;
 --chart-failure:#f28b82;--screen-failure-high:#f28b82;--screen-failure-low:#be635c;
 --chart-fade-strength:70%;
 --screen-prompt-user:#95b9d2;
 --focus:#e0e0e0;--scrim:#000000bd;
`;

export const screenFontStack = '"Asta Sans","Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';

export const screenTokens = `${tokens}
:root {
 --font:${screenFontStack};
 --weight-regular:400;--weight-medium:500;--weight-strong:600;--tracking-heading:0;
}
:root {${screenLight}}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) {${screenDark}}
}
:root[data-evidence-theme=light] {${screenLight}}
:root[data-evidence-theme=dark] {${screenDark}}
`;
