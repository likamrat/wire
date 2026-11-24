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
export const screenLight = `
 --update-fill:#007458;--update-ink:#ffffff;
 --page:#dbe8e7;--paper:#fcfefd;--canvas:#e6efed;--hover:#edf3f3;
 --screen-rail:#c7dbd8;--screen-plot:#f6faf9;--screen-grid:#92acac;--screen-tip:#204347;--screen-tip-ink:#f5faf9;
 --navigation-paper:var(--screen-rail);--context-paper:#f9fcfb;--floating-paper:var(--paper);
 --report-sheet:var(--paper);--report-note:var(--canvas);
 --surface-edge:var(--rule);--surface-divider:var(--rule);
 --outcome-tint:21%;--track-base:var(--paper);
 --panel-shadow:none;
 --surface-shadow:0 3px 8px #26344d14,0 16px 36px #26344d1c;
 --control-shadow:none;
 --navigation-sidebar-shadow:inset -1px 0 var(--surface-edge);
 --context-sidebar-shadow:inset 1px 0 #20202008,-3px 0 10px #0000000d,-14px 0 32px #0000001a;
 --toggle-on:#202d32;--toggle-thumb:#ffffff;--toggle-off:#e6eeee;
 --ink:#202d32;--muted:#244649;--rule:#b7cdce;--control:#596f73;
 --accent:#246469;--accent-soft:#e4eded;--accent-fill:#204347;--on-accent:#ffffff;
 --accent-hover:var(--hover);--accent-pressed:#dbe6e4;--pill-pressed:var(--accent-pressed);
 --primary-hover:#28454e;--primary-pressed:#15252c;
 --success:#006677;--danger:#af3e37;--warning:#7e6116;--unknown:#536171;
 --tool-positive:#175739;--tool-negative:#9b3334;
 --screen-returned-issue:#893f21;--disclosure-risk:#9b354b;--disclosure-masked:#235eaa;
 --delete-fill:var(--danger);--delete-ink:#ffffff;
 --performance-red:var(--danger);--performance-orange:#8c5518;--performance-gold:var(--warning);--performance-teal:var(--success);
 --chart-success:var(--success);--screen-success-high:var(--success);--screen-success-low:var(--success);
 --chart-failure:var(--danger);--screen-failure-high:var(--danger);--screen-failure-low:var(--danger);
 --chart-partial:var(--warning);--chart-unknown:var(--unknown);
 --screen-service-files:#007357;
 --screen-activity-assistance:#9b3c82;
 --screen-prompt-user:#365f7a;
 --screen-prompt-agent:#806018;
 --search-interaction:#235eaa;--search-context:#795997;--search-reply:#006c74;
 --search-action:#845b00;--search-tool:#943981;--search-service:#5b690b;
 --search-report:#236c45;--search-comparison:#a34c1c;--search-view:#3330bd;--search-setting:#545454;
 --search-ring-start:#2576b5;--search-ring-middle:#7864c3;--search-ring-end:#a650a0;--search-ring-focus:#59459b;
 --chart-mark-high:var(--accent);--chart-mark-low:var(--accent);--focus:#28454e;--scrim:#000000a6;
`;
export const screenDark = `
 --update-fill:#10b981;--update-ink:#0f111a;
 --page:#111e20;--paper:#213537;--canvas:#2c4244;--hover:#2b4143;
 --screen-rail:#192b2d;--screen-plot:#24383a;--screen-grid:#5f8180;--screen-tip:#d2e9e7;--screen-tip-ink:#163036;
 --navigation-paper:var(--screen-rail);--context-paper:#233739;--floating-paper:var(--paper);
 --report-sheet:var(--paper);--report-note:var(--canvas);
 --surface-edge:var(--rule);--surface-divider:var(--rule);
 --outcome-tint:15%;--track-base:var(--page);
 --panel-shadow:none;
 --surface-shadow:0 8px 24px #03081133;
 --control-shadow:none;
 --navigation-sidebar-shadow:inset -1px 0 var(--surface-edge);
 --context-sidebar-shadow:inset 1px 0 #b5cbe50d,-8px 0 24px #03081126;
 --toggle-on:#edf4f4;--toggle-thumb:#17202b;--toggle-off:#35464c;
 --ink:#edf4f4;--muted:#d3e4e5;--rule:#5f8180;--control:#a5bbbc;
 --accent:#a4d6d2;--accent-soft:#2e4445;--accent-fill:#c1e4e0;--on-accent:#17202b;
 --accent-hover:var(--hover);--accent-pressed:#314345;--pill-pressed:var(--accent-pressed);
 --primary-hover:#d3eaee;--primary-pressed:#c0d9df;
 --success:#75c6d3;--danger:#f0a097;--warning:#dcc080;--unknown:#b4c0cf;
 --tool-positive:#a0d7a3;--tool-negative:#ffa791;
 --screen-returned-issue:#f6b08c;--disclosure-risk:#ffacb1;--disclosure-masked:#79b6ff;
 --delete-fill:var(--danger);--delete-ink:#281210;
 --performance-red:var(--danger);--performance-orange:#e1ac74;--performance-gold:var(--warning);--performance-teal:var(--success);
 --chart-success:var(--success);--screen-success-high:var(--success);--screen-success-low:var(--success);
 --chart-failure:var(--danger);--screen-failure-high:var(--danger);--screen-failure-low:var(--danger);
 --chart-partial:var(--warning);--chart-unknown:var(--unknown);
 --screen-service-files:color-mix(in srgb,#10b981 70%,#ffffff);
 --screen-activity-assistance:#f2a2dd;
 --chart-fade-strength:74%;
 --screen-prompt-user:#95b9d2;
 --screen-prompt-agent:#e2c27b;
 --search-interaction:#79b6ff;--search-context:#c4a9e1;--search-reply:#66d0d7;
 --search-action:#e2b455;--search-tool:#e791ce;--search-service:#becb6b;
 --search-report:#7cce97;--search-comparison:#eea276;--search-view:#9f9bff;--search-setting:#abbbc7;
 --search-ring-start:#70b6ed;--search-ring-middle:#a69beb;--search-ring-end:#d18eca;--search-ring-focus:#b5a5f3;
 --copilot-chat-title:color-mix(in srgb,#ad88f0 70%,#ffffff);
 --chart-mark-high:var(--accent);--chart-mark-low:var(--accent);--focus:#d3eaee;--scrim:#050a12bd;
`;

export const screenFontStack = '"Asta Sans","Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';

export const screenTokens = `${tokens}
:root {
 --font:${screenFontStack};
 --weight-regular:400;--weight-medium:500;--weight-strong:600;--tracking-heading:0;
 --radius:12px;--radius-small:8px;--radius-dialog:12px;--radius-field:8px;
 --pill-weight:var(--weight-regular);
 --action-radius:var(--radius-small);
 --icon-navigation-size:1.125rem;--icon-utility-size:18px;
 --choice-row-inset:var(--space-md);
 --control-face-inset:6px;--control-hover-duration:160ms;--control-reveal-duration:140ms;
 --control-paint-transition:background-color var(--control-hover-duration) ease-out,border-color var(--control-hover-duration) ease-out,color var(--control-hover-duration) ease-out;
 --control-sheen:linear-gradient(180deg,#ffffff06,transparent);--control-sheen-edge:inset 0 1px 0 #ffffff0d;
 --pill-fill:var(--paper);--pill-border:var(--control);--shadow:var(--surface-shadow);
 --navigation-paper:var(--paper);--context-paper:var(--paper);--floating-paper:var(--paper);
 --state-transition:background-color 140ms ease,border-color 140ms ease,color 140ms ease,box-shadow 140ms ease;
}
:root[data-switching-appearance] {--state-transition:none;--control-paint-transition:none}
:root {${screenLight}}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) {${screenDark}}
}
:root[data-evidence-theme=light] {${screenLight}}
:root[data-evidence-theme=dark] {${screenDark}}
`;
