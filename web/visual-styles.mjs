export const visualStyles = `
.theme-control {display:block;margin-left:auto;color:var(--ink)}
.theme-trigger {display:flex;align-items:center;justify-content:center;width:80px;height:44px;min-height:44px;padding:2px;border:0;border-radius:var(--radius-pill);background:transparent;transition:none}
.theme-trigger:hover:not(:disabled),.theme-trigger:active:not(:disabled) {background:transparent}
.theme-track {position:relative;display:grid;grid-template-columns:repeat(2,36px);align-items:center;justify-items:center;width:76px;height:36px;padding:2px;border-radius:var(--radius-pill);background:var(--toggle-off);box-shadow:inset 0 0 0 1px var(--surface-divider);pointer-events:none}
.theme-trigger:hover:not(:disabled) .theme-track {background:var(--hover)}
.theme-thumb {position:absolute;top:2px;left:4px;width:32px;height:32px;border-radius:50%;background:var(--toggle-on);box-shadow:var(--control-shadow);transform:translateX(0);transition:transform 160ms ease-out,background-color 140ms ease}
.theme-trigger[aria-checked=true] .theme-thumb {transform:translateX(36px)}
.theme-track svg {display:block;width:20px;height:20px;fill:none;flex:none}
.theme-track svg {position:relative;color:var(--ink)}
.theme-trigger[aria-checked=false] [data-lucide-icon=sun],.theme-trigger[aria-checked=true] [data-lucide-icon=moon] {color:var(--toggle-thumb)}
@media(forced-colors:active) {
 .theme-track {background:Canvas;box-shadow:inset 0 0 0 1px ButtonText;forced-color-adjust:none}
 .theme-track svg {color:ButtonText}
 .theme-thumb {background:Highlight;box-shadow:none}
 .theme-trigger[aria-checked=false] [data-lucide-icon=sun],.theme-trigger[aria-checked=true] [data-lucide-icon=moon] {color:HighlightText}
}
@media(prefers-reduced-motion:reduce) {.theme-thumb {transition:none}}
.filters {border:0;box-shadow:none;background:transparent;padding:0;gap:12px}
.filters label {font-size:var(--type-small)}
.filters select {min-height:44px}
.chart-panel {border:1px solid var(--rule);box-shadow:none}
.view-switch {border:0}
.result-summary .result-with-help>button:not(.ux-help) {border-color:var(--pill-border);background:var(--pill-fill);color:var(--pill-ink);min-height:44px}
.result-summary .result-with-help>button:not(.ux-help):hover {background:var(--pill-hover)}
.session-identity {display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;min-width:0}
.session-identity>a {font-size:var(--type-body);min-width:0;overflow-wrap:anywhere}
.project-context {display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin:0;font-size:var(--type-small);line-height:1.5;min-width:0;max-width:100%}
.project-context-label {color:var(--muted);font-weight:var(--weight-regular)}
.project-context strong {font-weight:var(--weight-medium);overflow-wrap:anywhere}
.project-context.unscoped {color:var(--muted)}
.request-row {border:0;gap:12px;padding:16px;margin-top:8px;align-items:start}
.request-row>.status {background:transparent;padding:0;min-width:132px;text-align:right;line-height:1.6}
.request-intro {border:0}
.request-intro>.project-context {margin-bottom:12px}
.report-start {padding:20px 0;border:0;background:transparent;border-radius:0}
.report-options {grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:32px;margin:16px 0 28px}
.report-options fieldset {padding:0;border:0;background:transparent;border-radius:0}
.report-options legend {padding:0;margin:0 0 12px;font-size:var(--type-section)}
#promptOptions {display:grid;grid-auto-rows:1fr;gap:4px}
.prompt-choice {width:100%;margin:0;padding:12px;gap:12px;border:0;min-height:92px;background:transparent}
.prompt-choice:hover {background:var(--hover)}
.prompt-choice:has(input:checked) {background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}
.prompt-choice strong {font-size:var(--type-body)}
.prompt-choice span span {font-size:var(--type-small);line-height:1.55;margin-top:3px}
.prompt-choice:has(input:focus-visible),.format-choices label:has(input:focus-visible) {outline:2px solid var(--focus);outline-offset:3px}
.format-choices {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0 16px}
.format-choices label {justify-content:center;width:100%;min-height:44px;padding:10px 8px;border:0;background:var(--canvas);font-size:var(--type-small)}
.format-choices label:hover {background:var(--pill-hover)}
.format-choices label:has(input:checked) {background:var(--accent-soft);color:var(--accent);font-weight:var(--weight-regular)}
.report-options .muted {font-size:var(--type-small);line-height:1.6}
.report-options .detail-disclosure {border:0;margin-top:8px}
.report-options .detail-disclosure>summary {font-size:var(--type-small);font-weight:var(--weight-medium);min-height:44px}
.report-options .detail-disclosure+p {margin-top:8px}
@media(min-width:1080px) {.format-choices{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:760px) {
 .theme-control {margin-left:0}
 .report-options {grid-template-columns:minmax(0,1fr);gap:24px}
 .report-options fieldset {padding:0}
}
@media(max-width:600px) {
 .filters {padding:0;gap:12px}
 .filters label {flex-basis:140px}
 .session-identity {display:grid;gap:4px}
 .request-row {padding:14px 12px;gap:8px 12px}
 .request-row>.status {min-width:0;text-align:left;color:var(--muted)}
 .filter-chip {min-height:44px}
 .report-start {padding:12px 0}
 .prompt-choice {padding:12px;min-height:92px}
}
`;
