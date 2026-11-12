export const uxStyles = `
:where(details>summary).ux-disclosure {list-style:none}
:where(details>summary).ux-disclosure::-webkit-details-marker {display:none}
.ux-disclosure>.disclosure-icon {margin-inline-end:4px;vertical-align:calc((1cap - 16px)/2)}
:where(details[open]>summary) .disclosure-icon {transform:rotate(90deg)}
.progress-slot {display:inline-block;width:16px;height:16px;margin-inline-end:.5em;vertical-align:calc((1cap - 16px)/2);visibility:hidden}
.progress-slot-trailing {margin-inline:.5em 0}
.progress-slot-trailing:not(.pending-indicator) {display:none}
.pending-indicator {visibility:visible;animation:evidence-pending .8s linear infinite;flex-shrink:0}
.progress-slot>.wire-icon {display:block}
@keyframes evidence-pending {to {transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce) {.pending-indicator {animation:none}}
.wire-icon {display:inline-block;flex:none;vertical-align:middle;fill:none;stroke:currentColor;width:var(--icon-size);height:var(--icon-size)}
.wire-icon[data-icon-size="16"] {width:var(--icon-size-small);height:var(--icon-size-small)}
.wire-icon[data-icon-size="24"] {width:24px;height:24px}
.wire-icon.progress-icon-large {width:24px;height:24px}
.wire-icon.disclosure-icon {vertical-align:calc((1cap - 16px)/2)}
.icon-action,.filter-chip {display:inline-flex;align-items:center;justify-content:center;gap:var(--pill-gap)}
.icon-action>.wire-icon,.filter-chip>.wire-icon {display:block;flex:none}
button.icon-only,a.icon-only,.full-text-toggle.icon-only {display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:44px;min-height:44px;padding:10px}
.report-file-action {display:inline-flex;align-items:center;gap:4px}
:where(button,.button-link):has(>.progress-slot) {--action-progress-inset:12px;position:relative;display:inline-flex;align-items:center;justify-content:center;text-align:center;padding-inline:calc(var(--pill-inset) + var(--action-progress-inset))}
:where(button,.button-link)>.progress-slot {position:absolute;inset-inline-start:4px;margin:0;width:16px;height:16px}
p {max-width:72ch}
.brand {display:inline-flex;flex-direction:column;align-items:flex-start;gap:0;min-width:0;max-width:100%;white-space:normal;font-size:var(--type-brand);line-height:1.4;font-weight:var(--weight-strong);letter-spacing:-.015em}
.brand-home {display:flex;align-items:center;min-height:44px;max-width:100%}
.brand-home:is(:hover,:active) {background:transparent}
.brand-home:focus-visible {outline-offset:0}
.brand .brand-logo {display:block;flex:none;width:120px;height:auto;max-width:100%}
.brand .brand-logo[data-brand-theme=dark] {display:none}
:root[data-evidence-theme=dark] .brand .brand-logo[data-brand-theme=light] {display:none}
:root[data-evidence-theme=dark] .brand .brand-logo[data-brand-theme=dark] {display:block}
.brand-compact .brand-low {stop-color:var(--wire-brand-low)}
.brand-compact .brand-high {stop-color:var(--wire-brand-high)}
:root[data-evidence-theme=dark] .brand-compact .brand-low {stop-color:var(--wire-brand-dark-low)}
:root[data-evidence-theme=dark] .brand-compact .brand-high {stop-color:var(--wire-brand-dark-high)}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) .brand .brand-logo[data-brand-theme=light] {display:none}
 :root:not([data-evidence-theme]) .brand .brand-logo[data-brand-theme=dark] {display:block}
 :root:not([data-evidence-theme]) .brand-compact .brand-low {stop-color:var(--wire-brand-dark-low)}
 :root:not([data-evidence-theme]) .brand-compact .brand-high {stop-color:var(--wire-brand-dark-high)}
}
.header-inner {min-height:72px}
.app-header {z-index:var(--layer-header)}
.skip-link {z-index:var(--layer-skip)}
.app-header nav a {font-size:var(--type-small)}
.theme-control {font-size:var(--type-caption)}
.muted,.eyebrow,.breadcrumbs,.request-meta,.status,.pager,.supporting,.facts,.privacy-steps,
.chart-meta,.chart-footer,.time-axis {font-size:var(--type-caption);line-height:var(--leading-caption)}
.filters label,.collection-tools label,.search-label {font-size:var(--type-small);line-height:var(--leading-ui)}
.filters select,.collection-tools button,.search-label input,.bucket-control select,
.view-switch button,.chart-footer button,.filter-chip {font-size:var(--type-control);line-height:var(--leading-control)}
.group-name,.chart-actions,.journey-item p,.detail-disclosure,.report-start p,.report-entry p,
.notice,.empty-state p,.loading-state p,.attestation,.result-summary button,details p,#takeaway {font-size:var(--type-small)}
.request-link {font-size:var(--type-body);line-height:1.6}
.request-intro p,.report-document {font-size:var(--type-reading);line-height:var(--leading-reading)}
.request-intro .muted {font-size:var(--type-caption)}
code,kbd,samp,.mono,pre {font-family:var(--mono);font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;letter-spacing:0}
code,kbd,samp,.mono {font-size:var(--type-small);line-height:1.6}
code {overflow-wrap:anywhere}
:not(pre)>code {background:var(--canvas);padding:1px 4px;border-radius:4px}
.journey-item p.mono {font-family:var(--mono);font-size:var(--type-small)}
table,.report-document table {font-size:var(--type-caption);line-height:1.6}
td,th {padding:12px 8px}
th.numeric,.numeric,.row-total,.result-count,.facts dd {font-variant-numeric:tabular-nums}
.chart-heading,.section-heading,.dialog-head {align-items:center}
.chart-heading h2 {margin-right:auto}
.chart-heading,.section-heading {flex-wrap:wrap}
.request-intro,.journey-item,.report-entry,.report-document,.dialog-body,#detail,#reportList {min-width:0;max-width:100%}
.report-document li {overflow-wrap:anywhere}
.prompt-choice input[type=radio],.format-choices input[type=checkbox],.attestation input[type=checkbox],.request-row input[type=checkbox] {width:18px;height:18px;min-width:18px;min-height:18px;padding:0;flex:0 0 auto}
.prompt-choice input[type=radio] {margin:3px 0 0}
.format-choices input[type=checkbox] {margin:0}
.prompt-choice small {font-size:var(--type-caption)}
.prompt-pair h4 {font-size:var(--type-body);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
pre {font-size:var(--type-small);line-height:var(--leading-reading);white-space:pre;overflow-wrap:normal;word-break:normal;tab-size:4;max-width:100%;text-align:left}
.original-prompt pre,.prompt-original pre,.prompt-report pre,.ux-code-block.prose pre {
 font-family:var(--font);font-size:var(--type-reading);line-height:var(--leading-reading);
 white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;
}
.ux-code-block {min-width:0;max-width:100%;margin:12px 0;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--canvas);overflow:clip}
.ux-code-toolbar {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;padding:6px 8px 6px 16px;border-bottom:1px solid var(--rule);background:var(--paper);min-width:0}
.ux-code-label {flex:1;min-width:0;font-size:var(--type-caption);font-family:var(--font);font-weight:var(--weight-medium);color:var(--muted);overflow-wrap:anywhere}
.ux-code-block>pre {margin:0;border-radius:0;min-width:0;scrollbar-gutter:stable;max-height:360px}
.ux-code-block>pre:focus-visible {outline:2px solid var(--focus);outline-offset:-3px}
.ux-copy {width:44px;height:44px;min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center;padding:10px;flex:0 0 auto;color:var(--accent);border:1px solid var(--control);background:var(--paper);vertical-align:middle}
.ux-copy svg {width:20px;height:20px;display:block;fill:none;flex:0 0 auto}
.ux-copy[data-copy-state=success] {color:var(--success)}
.ux-copy[data-copy-state=error] {color:var(--danger);border-color:var(--danger)}
.ux-copy[aria-disabled=true] {cursor:progress;color:var(--muted)}
.ux-copy-status {flex-basis:100%;grid-column:1/-1;font-family:var(--font);font-size:var(--type-caption)!important;line-height:var(--leading-ui)!important;max-width:none!important;margin:0!important;color:var(--success)!important;padding:4px 0}
.ux-copy-status.error {color:var(--danger)!important}
.ux-copy-status.visually-hidden {padding:0}
.ux-inline-code {display:inline-grid;grid-template-columns:minmax(0,1fr) auto;width:fit-content;align-items:center;gap:4px 10px;min-width:0;max-width:100%;margin:8px 0}
.ux-inline-code>code {overflow-wrap:anywhere;white-space:pre-wrap;word-break:normal;min-width:0;padding:0;background:transparent}
.ux-inline-code>.ux-copy-status {contain:inline-size;min-width:0;overflow-wrap:anywhere}
.facts .ux-inline-code {margin:0}
.facts .ux-inline-code>code {font:inherit;letter-spacing:inherit}
.facts .ux-copy {width:44px;height:44px;min-width:44px;min-height:44px}
.technical-detail {container-type:inline-size}
.technical-detail .technical-facts {grid-template-columns:minmax(0,12rem) minmax(0,1fr);gap:4px 16px}
.technical-facts>dt,.technical-facts>dd {min-height:44px;display:flex;align-items:center;min-width:0}
.technical-facts>dd {flex-direction:column;align-items:flex-start;justify-content:center}
@container (max-width:32rem) {
 .technical-detail .technical-facts {grid-template-columns:minmax(0,1fr);gap:0}
 .technical-facts>dd {min-height:0;margin-bottom:12px}
}
code.api-path {display:block;width:fit-content;min-width:0;max-width:100%;padding:4px 8px;border-radius:4px;background:var(--canvas);color:var(--ink);font-family:var(--mono);font-size:var(--type-small);font-weight:var(--weight-regular);line-height:1.6;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;letter-spacing:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;user-select:text}
.ux-tooltip {position:fixed;inset:auto;margin:0;border:1px solid var(--paper);border-radius:var(--radius-small);padding:var(--space-sm) var(--space-md);width:max-content;max-width:min(28rem,calc(100vw - 2 * var(--tooltip-gap)));max-height:calc(100dvh - 2 * var(--tooltip-gap));overflow:auto;overscroll-behavior:contain;background:var(--ink);color:var(--paper);font:var(--type-small)/1.5 var(--font);box-shadow:var(--shadow);overflow-wrap:anywhere;z-index:var(--layer-tooltip);text-align:left}
.ux-tooltip::backdrop {background:transparent;pointer-events:none}
@media(forced-colors:active) {.ux-tooltip {background:Canvas;color:CanvasText;border-color:CanvasText;box-shadow:none}}
/* Inline-flex exposes the glyph baseline, not the expanded hit target's bottom. */
.ux-help {display:inline-flex;align-items:center;justify-content:flex-start;vertical-align:calc((1cap - var(--help-icon))/2);flex:0 0 auto;width:max(44px,var(--help-target));height:max(44px,var(--help-target));min-width:44px;min-height:44px;padding:0;border:0;border-radius:var(--radius-small);background:transparent;color:var(--muted);font:inherit;touch-action:manipulation}
.ux-help>svg.wire-icon {display:block;width:var(--help-icon);height:var(--help-icon);fill:none;flex:0 0 auto}
.ux-help:hover:not(:disabled),.ux-help:active:not(:disabled) {color:var(--ink);background:transparent;border-color:transparent}
.help-heading {display:flex;align-items:center;gap:var(--help-gap);min-width:0}
.help-heading>label {flex:initial}
.help-heading:has(>label) {display:block;font-size:var(--type-small);line-height:1.5;text-wrap:balance}
.help-heading:has(>label)>label,.filters .filter-field>.help-heading>label {display:inline;padding-block:0}
.help-heading:has(>label)>.ux-help {margin-inline-start:var(--help-gap)}
legend>.ux-help,dt>.ux-help {margin-inline-start:var(--help-gap)}
.filters .filter-field {flex:1 1 130px;min-width:0;display:flex;flex-direction:column;gap:4px}
.filters .filter-field>.help-heading {min-height:var(--help-target)}
.filters .filter-field label {display:block;flex:initial}
.filters .filter-field select {color:var(--ink)}
.chart-meta-help {display:inline-flex;align-items:center;gap:var(--help-gap);color:var(--muted);font-size:var(--type-caption)}
.service-chart-row {display:grid;grid-template-columns:minmax(130px,25%) 40px minmax(0,1fr) 44px;column-gap:12px}
.service-chart-row .chart-row {grid-column:1/-1;grid-row:1;grid-template-columns:subgrid;column-gap:12px}
.service-chart-row .group-name {grid-column:1}
.service-chart-row .row-bar {grid-column:3}
.service-chart-row .row-total {grid-column:4}
.service-chart-row>.ux-help {grid-column:2;grid-row:1;align-self:center;justify-self:center;z-index:1}
.service-definitions {margin:8px 0 0}
.service-definitions dl {margin:8px 0}
.service-definitions dt {font-weight:var(--weight-medium)}
.service-definitions dd {margin:0 0 12px;color:var(--muted);max-width:72ch}
.result-with-help {display:inline-flex;align-items:center;gap:0}
.result-summary .ux-help {width:var(--help-target);min-width:var(--help-target);height:var(--help-target);min-height:var(--help-target);padding:0}
.help-heading>h3,.help-heading>h4 {margin:0}
.field-help-choice {display:flex;align-items:center;gap:var(--help-gap);min-width:0}
.field-help-choice>label {flex:0 1 auto;min-width:0}
.format-choices .field-help-choice>label {width:auto}
.ux-disabled-help {display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;border-radius:var(--radius-pill)}
.ux-disabled-help:focus-visible,[data-ux-tooltip][tabindex="0"]:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.ux-disabled-help>button:not(.ux-help,.icon-only) {flex:1;min-width:0}
.report-start>.ux-disabled-help {flex:0 0 auto}
@media(max-width:760px) {
 .header-inner {min-height:0}
 .brand {font-size:1rem}
 .theme-control {font-size:var(--type-caption);gap:6px}
 .app-header nav a {font-size:var(--type-caption)}
}
@media(max-width:600px) {
 .ux-copy {width:44px;height:44px;min-width:44px;min-height:44px}
 .ux-code-toolbar {padding:4px 6px 4px 12px}
 .ux-code-block>pre {padding:12px}
 .section-heading {align-items:stretch}
 .facts {grid-template-columns:minmax(80px,30%) minmax(0,1fr);gap:8px 12px}
 .report-start>.ux-disabled-help {align-self:start}
 #activityCount {font-size:2rem}
 .filters .filter-field {flex-basis:130px}
 .service-chart-row {grid-template-columns:minmax(0,1fr) 44px 40px;column-gap:8px}
 .service-chart-row .chart-row {gap:8px}
 .service-chart-row .group-name {grid-column:1}
 .service-chart-row .row-bar {grid-column:1/-1;grid-row:2}
 .service-chart-row .row-total {grid-column:3;grid-row:1}
 .service-chart-row>.ux-help {align-self:start;margin-top:1px}
}
@media(pointer:coarse) and (min-width:601px) {
 .ux-copy {width:44px;height:44px;min-width:44px;min-height:44px}
 .service-chart-row {grid-template-columns:minmax(130px,25%) 44px minmax(0,1fr) 44px}
 .service-chart-row .chart-row {min-height:66px}
}
`;
