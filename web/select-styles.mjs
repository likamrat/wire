export const selectStyles = `
:root {--layer-select:6;--select-radius:var(--radius);--select-value-inset:max(12px,.5rem);--select-field-gap:4px;--select-help-target:var(--help-target)}
.select-source {display:none!important}
.select-control {display:inline-flex;width:fit-content;min-width:0;max-width:100%;align-self:start;vertical-align:middle}
:is(.select-field:not(.bucket-control),.filter-field:has(>.select-control)) {
 display:flex;flex-direction:column;gap:var(--select-field-gap);min-width:0;
}
:is(.select-field:not(.bucket-control),.filter-field:has(>.select-control))>label,
.filter-field:has(>.select-control)>.help-heading {padding-inline:var(--select-value-inset)}
.filter-field:has(>.select-control)>.help-heading {align-items:end;min-height:var(--select-help-target)}
.filter-field:has(>.select-control)>.help-heading>label {
 line-height:1.5;overflow-wrap:anywhere;
}
.filter-field:has(>.select-control)>.help-heading>.ux-help {
 width:var(--select-help-target);min-width:var(--select-help-target);
 height:var(--select-help-target);min-height:var(--select-help-target);
}
.select-field>label {flex:initial;min-width:0}
.collection-tools>.select-field {flex:1 1 130px;max-width:240px}
.collection-tools .select-field>label {flex:initial;max-width:none}
.select-trigger {
 position:relative;isolation:isolate;display:inline-grid;grid-template-columns:minmax(0,1fr) 16px;
 align-items:center;column-gap:var(--pill-gap);width:100%;min-width:44px;min-height:max(44px,calc(1lh + 16px));padding:8px var(--select-value-inset);
 border:0;border-radius:var(--radius-field);background:transparent;color:var(--pill-ink);
 font-size:var(--type-control);font-weight:var(--pill-weight);line-height:var(--leading-control);text-align:left;
 box-shadow:none;touch-action:manipulation;
}
.select-trigger::before {
 content:"";position:absolute;inset:var(--control-face-inset) 0;z-index:-1;border:1px solid var(--control);
 border-radius:inherit;background:var(--pill-fill);box-shadow:none;transition:var(--control-paint-transition);
}
.select-trigger:hover:not(:disabled),.select-trigger:active:not(:disabled),.select-trigger:disabled {background:transparent;border:0}
.select-trigger:hover:not(:disabled)::before {background:var(--pill-hover);border:1px solid var(--ink)}
.select-trigger[aria-expanded=true]::before {background:var(--control-sheen),var(--accent-soft);border-color:var(--control);box-shadow:var(--control-sheen-edge)}
.select-trigger:active:not(:disabled)::before {background:var(--pill-pressed);border-color:var(--control)}
.select-trigger:focus-visible {outline:0}
.select-trigger:focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
.select-trigger:disabled {color:var(--muted)}
.select-trigger:disabled::before {background:transparent;border-color:var(--rule);box-shadow:none}
.select-trigger .select-value {display:block;white-space:normal;overflow-wrap:anywhere;min-width:0}
.select-trigger .select-chevron {display:block;width:16px;height:16px;flex:none;fill:none;transition:transform var(--control-hover-duration) cubic-bezier(.2,0,0,1)}
.select-trigger[aria-expanded=true] .select-chevron {transform:rotate(180deg)}
.filters .filter-field {flex:0 1 auto;min-width:min(100%,9rem);max-width:100%}
.filters .filter-field:has(#dateFilter) {width:9.5rem}
.filters .filter-field:has(#serviceFilter),.filters .filter-field:has(#outcomeFilter) {width:9.75rem}
.filters .filter-field:has(#projectFilter),.filters .filter-field:has(#layerFilter) {width:13.25rem}
.filters .select-control {width:fit-content}
.filters {align-items:end;gap:8px 12px}
.chart-heading .select-control {width:max-content;flex:none}
.chart-heading #bucketControl>.select-control {align-self:baseline}
.chart-heading .select-trigger {padding:0 6px;column-gap:4px;font-weight:var(--weight-medium);border-radius:8px}
.chart-heading .select-value,.select-option-sizer {grid-area:1/1}
.chart-heading .select-value {overflow:visible;text-overflow:clip}
.chart-heading .select-chevron {grid-area:1/2}
.select-option-sizer {display:grid;visibility:hidden;pointer-events:none;white-space:nowrap}
.select-option-sizer>span {grid-area:1/1}
.chart-heading .select-trigger::before {border:0;background:transparent}
.chart-heading .select-trigger:hover:not(:disabled)::before {background:var(--hover)}
.chart-heading .select-trigger[aria-expanded=true]::before {background:var(--accent-soft)}
.collection-tools .select-control {width:fit-content}
.select-popup {
 position:fixed;inset:auto;margin:0;z-index:var(--layer-select);box-sizing:border-box;
 width:max-content;max-width:min(36em,var(--select-available-width,calc(100vw - 16px)));max-height:20rem;overflow:auto;overscroll-behavior:contain;
 padding:6px;border:1px solid var(--rule);border-radius:var(--select-radius);
 background:var(--paper);color:var(--ink);box-shadow:var(--shadow);
 font:var(--type-control)/var(--leading-control) var(--font);scrollbar-width:thin;scrollbar-color:var(--control) transparent;
}
.select-popup::backdrop {background:transparent}
.select-popup:popover-open {animation:select-reveal var(--control-reveal-duration) ease-out}
@keyframes select-reveal {from {opacity:0} to {opacity:1}}
.select-option {
 display:grid;grid-template-columns:minmax(0,1fr) 20px;align-items:center;column-gap:10px;
 min-height:44px;padding:7px 10px;border-radius:var(--radius-field);cursor:pointer;overflow-wrap:anywhere;
}
.select-option+.select-option {margin-top:2px}
.select-option[aria-selected=true] {background:var(--accent-soft);color:var(--accent);font-weight:var(--weight-medium)}
.select-option[data-active=true] {background:var(--hover)}
.select-option[aria-selected=true][data-active=true] {background:var(--accent-soft)}
:root:has(.select-trigger[aria-expanded=true]:focus-visible) .select-option[data-active=true] {outline:2px solid var(--focus);outline-offset:-2px}
.select-check {display:block;width:16px;height:16px;justify-self:center;visibility:hidden;fill:none}
.select-option-label {min-width:0;white-space:normal;overflow-wrap:anywhere}
.select-option-detail {grid-column:1/-1;display:block;margin-top:3px;color:var(--muted);font-size:var(--type-caption);font-weight:var(--weight-regular);line-height:1.45;overflow-wrap:anywhere}
.select-option[aria-selected=true] .select-check {visibility:visible}
.select-option[aria-disabled=true] {color:var(--muted);cursor:not-allowed}
.select-group {padding:6px 10px;color:var(--muted);font-size:var(--type-caption);font-weight:var(--weight-medium)}
.select-popup-multiple {max-width:min(32em,var(--select-available-width,calc(100vw - 16px)));max-height:calc(100dvh - 16px)}
.select-popup-multiple .select-check {width:20px;height:20px;visibility:visible;border:0;border-radius:4px;padding:2px;outline:1px solid var(--control);outline-offset:-1px;fill:none}
.select-popup-multiple .select-check>* {visibility:hidden}
.select-popup-multiple .select-option[aria-selected=true] .select-check {outline-color:currentColor}
.select-popup-multiple .select-option[aria-selected=true] .select-check>* {visibility:visible}
.select-all {width:100%;justify-content:flex-start;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--rule);border-radius:0;margin-bottom:4px}
.select-draft-hint {font-size:var(--type-caption);line-height:1.5;color:var(--muted);margin:8px 10px}
.select-footer {display:flex;flex-wrap:wrap;gap:8px;padding:6px 10px;border-top:1px solid var(--rule)}
.select-trigger.select-trigger-filter {border-radius:24px;font-weight:var(--weight-regular)}
.select-trigger.select-trigger-filter::before {inset:var(--control-face-inset) 0;border-color:var(--control);background:var(--paper);box-shadow:none}
.select-trigger.select-trigger-filter:hover:not(:disabled)::before {border-color:var(--ink);background:var(--paper)}
.select-trigger.select-trigger-filter:is([data-filter-active=true],[aria-expanded=true])::before {border-color:var(--control);background:var(--paper);box-shadow:var(--control-shadow)}
.select-trigger.select-trigger-filter[aria-expanded=true]::before {background-image:var(--control-sheen);box-shadow:var(--control-sheen-edge)}
.select-trigger.select-trigger-filter:disabled::before {border-style:dashed;border-color:var(--rule);box-shadow:none}
.select-popup-filter {
 min-width:min(max(16rem,var(--select-anchor-width)),var(--select-available-width));
 max-width:min(28rem,var(--select-available-width));max-height:min(28rem,calc(100dvh - 16px));
 padding:8px;border-radius:var(--select-radius);background:var(--paper);box-shadow:var(--surface-shadow);
}
.select-popup-filter .select-option {grid-template-columns:minmax(0,1fr) 32px;column-gap:16px;padding:8px 12px;border-radius:var(--radius-control)}
.select-popup-filter .select-option:has(.select-option-count) {grid-template-columns:minmax(0,1fr) auto 32px}
.select-option-count {max-inline-size:10ch;font-variant-numeric:tabular-nums;color:var(--muted);font-size:var(--type-caption);text-align:end}
.select-popup-filter .select-option,
.select-popup-filter .select-option:is([aria-selected=true],[data-active=true]) {background:transparent;color:var(--ink);font-weight:var(--weight-regular);outline:none}
.select-popup-filter .select-option[aria-selected=true] {background:var(--accent-soft)}
.select-popup-filter :is(.select-option,.select-all):not([aria-disabled=true],:disabled):hover {background:var(--hover)}
.select-popup-filter .select-option[aria-selected=true]:hover {background:var(--accent-hover)}
:root:has(.select-trigger-filter[aria-expanded=true]:focus-visible) .select-popup-filter .select-option[data-active=true] {outline:2px solid var(--focus);outline-offset:-2px}
.select-popup-filter .select-option[aria-disabled=true] {color:var(--muted)}
.select-toggle {position:relative;display:block;width:32px;height:20px;border:1px solid var(--control);border-radius:20px;background:var(--toggle-off);box-shadow:var(--control-shadow)}
.select-toggle::after {content:"";position:absolute;width:12px;height:12px;inset:3px auto auto 3px;border-radius:50%;background:var(--muted);transform:translateX(0)}
.select-option[aria-selected=true] .select-toggle,.select-all[aria-checked=true] .select-toggle {border-color:var(--toggle-on);background:var(--toggle-on)}
.select-option[aria-selected=true] .select-toggle::after,.select-all[aria-checked=true] .select-toggle::after {transform:translateX(12px);background:var(--toggle-thumb)}
.select-all[aria-checked=mixed] .select-toggle::after {width:10px;height:2px;left:10px;top:8px;border-radius:1px;background:var(--ink)}
.select-option[aria-disabled=true] .select-toggle {box-shadow:none;border-color:var(--muted)}
.select-option[aria-disabled=true][aria-selected=true] .select-toggle {background:var(--muted)}
@media(prefers-reduced-motion:no-preference) {
 .select-toggle {transition:var(--state-transition)}
 .select-toggle::after {transition:transform 140ms ease,background-color 140ms ease}
}
@media(forced-colors:active) {
 .select-trigger[aria-expanded=true]::before,.select-trigger.select-trigger-filter[aria-expanded=true]::before {background-image:none;box-shadow:none}
 .select-popup-filter .select-option[aria-selected=true] {outline:1px solid Highlight;outline-offset:-1px}
 .select-toggle {background:Canvas;border-color:ButtonText;box-shadow:none;forced-color-adjust:none}
 .select-toggle::after {background:ButtonText}
 .select-all[aria-checked=mixed] .select-toggle::after {background:ButtonText}
 .select-option[aria-selected=true] .select-toggle,.select-all[aria-checked=true] .select-toggle {background:Highlight;border-color:Highlight}
 .select-option[aria-selected=true] .select-toggle::after,.select-all[aria-checked=true] .select-toggle::after {background:HighlightText}
 .select-option[aria-disabled=true] .select-toggle {border-color:GrayText}
 .select-option[aria-disabled=true][aria-selected=true] .select-toggle {background:GrayText}
}
.select-popup-filter.select-popup-multiple .select-all {display:flex;justify-content:space-between;gap:16px;min-height:44px;font-weight:var(--weight-regular);border:0;border-radius:12px}
.select-popup-filter.select-popup-multiple .select-all::before {content:none}
.select-all-label {min-width:0;overflow-wrap:anywhere}
.select-all>.select-toggle {flex:none}
.select-popup-filter.select-popup-multiple [role=listbox] {border-top:1px solid var(--rule);padding-top:4px}
.select-popup-filter .select-footer {gap:8px;padding:10px 12px 4px}
.select-popup-filter .select-footer>button {
 --pill-fill:var(--paper);--pill-hover:var(--paper);--pill-pressed:var(--paper);--canvas:var(--paper);
 --pill-border:var(--control);min-height:44px;border-radius:24px;font-weight:var(--weight-regular);
}
.select-popup-filter .select-footer>.select-apply,.select-popup-filter .select-footer>button:hover {--pill-border:var(--control)}
.select-popup-filter .select-validation {margin:10px 12px;color:var(--muted);font-size:var(--type-caption);line-height:1.5}
.filter-chip {min-height:44px;padding:4px 12px;gap:6px;line-height:20px;border-radius:var(--radius-control)}
.view-switch {padding:0;gap:var(--pill-gap);border-radius:var(--radius-control);background:transparent;flex-wrap:wrap;max-width:100%;flex-shrink:1}
.view-switch button {min-height:var(--pill-height);padding:6px var(--pill-inset);line-height:1.5;border-radius:var(--radius-control);background:var(--pill-fill);color:var(--pill-ink);border-color:var(--pill-border);white-space:normal}
.view-switch button[aria-pressed=true] {background:var(--pill-hover);color:var(--pill-ink);border-color:var(--pill-border);font-weight:var(--weight-strong);box-shadow:inset 0 0 0 1px var(--pill-border)}
.result-summary button {min-height:44px;padding:6px 12px;gap:6px;line-height:22px;border-radius:var(--radius-control)}
.format-choices {grid-auto-rows:1fr}
.format-choices .field-help-choice>label {align-self:stretch}
.format-choices label {min-height:44px;padding:6px 12px;border-radius:var(--radius-control)}
.filter-chip,.format-choices label {position:relative;isolation:isolate;border:0;color:var(--pill-ink);font-weight:var(--pill-weight);line-height:1.5}
.filter-chip,.filter-chip:hover:not(:disabled),
.format-choices label,.format-choices label:hover,.format-choices label:has(input:checked) {background:transparent}
.filter-chip::before,.format-choices label::before {
 content:"";position:absolute;inset:4px 0;z-index:-1;border:1px solid var(--pill-border);border-radius:inherit;background:var(--pill-fill);
}
.filter-chip {min-height:max(44px,calc(1lh + 20px));padding-block:10px}
.format-choices label {min-height:max(44px,calc(1lh + 16px));padding-block:8px}
.format-choices .field-help-choice {position:relative;isolation:isolate;border-radius:var(--radius-control);padding-inline-start:var(--pill-inset)}
.format-choices .field-help-choice>label {flex:none;justify-content:flex-start;padding-inline:0;white-space:nowrap}
.format-choices .field-help-choice>label::before {display:none}
.format-choices .field-help-choice::before {content:"";position:absolute;inset:4px 0;z-index:-1;border:1px solid var(--pill-border);border-radius:inherit;background:var(--pill-fill)}
.format-choices .field-help-choice:has(input:checked)::before {background:var(--pill-hover);box-shadow:inset 0 0 0 1px var(--pill-border)}
.format-choices .field-help-choice:has(label:hover)::before {background:var(--pill-hover)}
#formatOptions {container:report-formats / inline-size}
@container report-formats (max-width:40rem) {.format-choices:has(.field-help-choice) {grid-template-columns:repeat(2,minmax(0,1fr))}}
@container report-formats (max-width:20rem) {.format-choices:has(.field-help-choice) {grid-template-columns:minmax(0,1fr)}}
.filter-chip::before {inset:6px 0}
.format-choices label:has(input:checked)::before {background:var(--pill-hover);box-shadow:inset 0 0 0 1px var(--pill-border)}
.format-choices label:has(input:checked) {color:var(--pill-ink)}
.filter-chip:hover::before,.format-choices label:hover::before {background:var(--pill-hover)}
.filter-chip:active:not(:disabled) {background:transparent;box-shadow:none}
.filter-chip:active:not(:disabled)::before {background:var(--pill-hover);box-shadow:inset 0 0 0 1px var(--pill-border)}
@media(pointer:coarse) {
 .select-option {min-height:44px}
 .filter-chip,.view-switch button,.result-summary button,.format-choices label {min-height:44px}
}
@media(max-width:600px) {
 .filters .filter-field {flex:1 1 calc(50% - 6px);width:auto}
 .filters .filter-field:has(#layerFilter) {flex-basis:100%;max-width:24rem}
}
@media(prefers-reduced-motion:reduce) {
 .select-trigger::before,.select-trigger .select-chevron {transition:none}
 .select-popup:popover-open {animation:none}
}
`;
