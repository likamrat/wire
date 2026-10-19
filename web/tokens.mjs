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
 --page:#f1f3f7;--paper:#ffffff;--canvas:#f4f5f8;--hover:#f7f7f7;
 --surface-edge:#20202012;--surface-divider:#20202024;
 --panel-shadow:0 1px 2px #26344d0a,0 6px 18px #26344d0d;
 --surface-shadow:0 3px 8px #26344d14,0 16px 36px #26344d1c;
 --control-shadow:inset 0 1px 0 #ffffff80,0 1px 3px #26344d14;
 --navigation-sidebar-shadow:inset -1px 0 #20202008,3px 0 10px #0000000d,14px 0 32px #0000001a;
 --context-sidebar-shadow:inset 1px 0 #20202008,-3px 0 10px #0000000d,-14px 0 32px #0000001a;
 --toggle-on:#486cbb;--toggle-thumb:#ffffff;--toggle-off:#f0f2f7;
 --ink:#202020;--muted:#565656;--rule:#c9c9c9;--control:#747474;
 --accent:#303030;--accent-soft:#f1f1f1;--accent-fill:#303030;--on-accent:#ffffff;
 --accent-hover:#ebebeb;--accent-pressed:#e5e5e5;--pill-pressed:#ededed;
 --primary-hover:#202020;--primary-pressed:#101010;
 --danger:#b3261e;--delete-fill:#b3261e;--delete-ink:#ffffff;--performance-red:#b3261e;
 --chart-success:#286336;--screen-success-high:#60906e;--screen-success-low:#325f40;
 --chart-failure:#b3261e;--screen-failure-high:#c17169;--screen-failure-low:#9e403a;
 --screen-service-files:#007357;
 --screen-prompt-user:#365f7a;
 --search-interaction:#235eaa;--search-context:#795997;--search-reply:#006c74;
 --search-action:#845b00;--search-tool:#943981;--search-service:#5b690b;
 --search-report:#236c45;--search-comparison:#a34c1c;--search-view:#3330bd;--search-setting:#545454;
 --search-ring-start:#2576b5;--search-ring-middle:#7864c3;--search-ring-end:#a650a0;--search-ring-focus:#59459b;
 --focus:#303030;--scrim:#000000a6;
`;
const screenDark = `
 --page:#111111;--paper:#202020;--canvas:#292929;--hover:#282828;
 --surface-edge:#ffffff0e;--surface-divider:#ffffff1c;
 --panel-shadow:inset 0 1px 0 #ffffff05,0 2px 4px #00000033,0 10px 24px #00000033;
 --surface-shadow:inset 0 1px 0 #ffffff0a,0 4px 12px #00000066,0 20px 44px #00000066;
 --control-shadow:inset 0 1px 0 #ffffff0d,0 1px 3px #0000004d;
 --navigation-sidebar-shadow:inset -1px 0 #ffffff08,3px 0 10px #00000055,16px 0 36px #00000066;
 --context-sidebar-shadow:inset 1px 0 #ffffff08,-3px 0 10px #00000055,-16px 0 36px #00000066;
 --toggle-on:#8fa8eb;--toggle-thumb:#17213b;--toggle-off:#292c35;
 --ink:#f2f2f2;--muted:#b8b8b8;--rule:#444444;--control:#888888;
 --accent:#e0e0e0;--accent-soft:#2d2d2d;--accent-fill:#e0e0e0;--on-accent:#191919;
 --accent-hover:#323232;--accent-pressed:#383838;--pill-pressed:#333333;
 --primary-hover:#f2f2f2;--primary-pressed:#ffffff;
 --danger:#f28b82;--delete-fill:#f28b82;--delete-ink:#281210;--performance-red:#f28b82;
 --chart-success:#83d494;--screen-success-high:#83d494;--screen-success-low:#528d5e;
 --chart-failure:#f28b82;--screen-failure-high:#f28b82;--screen-failure-low:#be635c;
 --screen-service-files:#10b981;
 --chart-fade-strength:74%;
 --screen-prompt-user:#95b9d2;
 --search-interaction:#79b6ff;--search-context:#c4a9e1;--search-reply:#66d0d7;
 --search-action:#e2b455;--search-tool:#e791ce;--search-service:#becb6b;
 --search-report:#7cce97;--search-comparison:#eea276;--search-view:#9f9bff;--search-setting:#abbbc7;
 --search-ring-start:#70b6ed;--search-ring-middle:#a69beb;--search-ring-end:#d18eca;--search-ring-focus:#b5a5f3;
 --focus:#e0e0e0;--scrim:#000000bd;
`;

// Native forced colors retain the base palette; ordinary dark screens use these material roles.
const darkScreenSurfaces = `
 --page:#10161f;--paper:#192330;--navigation-paper:var(--page);
 --context-paper:#1c2939;--floating-paper:#202c3b;--canvas:#14212f;--hover:#1e2b3b;
 --ink:#f2f4f8;--muted:#bbc5d4;--rule:#3d4e64;--control:#8b9cb2;
 --surface-edge:#bfd2ee1a;--surface-divider:#bfd2ee24;
 --panel-shadow:inset 0 1px 0 #c0d6f008,0 1px 2px #050b1414;
 --control-shadow:inset 0 1px 0 #d3e3fa0a;
 --surface-shadow:0 8px 24px #03081133;
 --navigation-sidebar-shadow:inset -1px 0 #b5cbe514;
 --context-sidebar-shadow:inset 1px 0 #b5cbe50d,-8px 0 24px #03081126;
 --accent:#dbe7f7;--accent-soft:#202c3b;--accent-fill:#dbe7f7;--on-accent:#142130;
 --accent-hover:#1e2b3b;--accent-pressed:#142332;--pill-pressed:#142332;
 --primary-hover:#edf4fc;--primary-pressed:#c7d8ee;
 --focus:#bdd6ff;--toggle-off:#152435;--scrim:#050a12bd;
`;

export const screenFontStack = '"Asta Sans","Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';

export const screenTokens = `${tokens}
:root {
 --font:${screenFontStack};
 --weight-regular:400;--weight-medium:500;--weight-strong:600;--tracking-heading:0;
 --radius:12px;--radius-small:10px;--radius-dialog:12px;--radius-field:8px;
 --pill-fill:var(--paper);--pill-border:var(--surface-edge);--shadow:var(--surface-shadow);
 --navigation-paper:var(--paper);--context-paper:var(--paper);--floating-paper:var(--paper);
 --state-transition:background-color 140ms ease,border-color 140ms ease,color 140ms ease,box-shadow 140ms ease;
}
:root {${screenLight}}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) {${screenDark}}
}
:root[data-evidence-theme=light] {${screenLight}}
:root[data-evidence-theme=dark] {${screenDark}}
@media(prefers-color-scheme:dark) and (forced-colors:none) {
 :root:not([data-evidence-theme]) {${darkScreenSurfaces}}
}
@media(forced-colors:none) {
 :root[data-evidence-theme=dark] {${darkScreenSurfaces}}
}
`;
