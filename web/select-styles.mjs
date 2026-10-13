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
 content:"";position:absolute;inset:4px 0;z-index:-1;border:1px solid var(--pill-border);
 border-radius:inherit;background:var(--pill-fill);transition:border-color 120ms;
}
.select-trigger:hover:not(:disabled),.select-trigger:active:not(:disabled),.select-trigger:disabled {background:transparent;border:0}
.select-trigger:hover:not(:disabled)::before {background:var(--pill-hover);border-color:var(--pill-border)}
.select-trigger[aria-expanded=true]::before,.select-trigger:active:not(:disabled)::before {background:var(--pill-hover);border-color:var(--pill-border);box-shadow:inset 0 0 0 1px var(--pill-border)}
.select-trigger:focus-visible {outline:0}
.select-trigger:focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
.select-trigger:disabled {color:var(--muted)}
.select-trigger:disabled::before {background:var(--canvas);border-color:var(--rule)}
.select-trigger .select-value {display:block;white-space:normal;overflow-wrap:anywhere;min-width:0}
.select-trigger .select-chevron {display:block;width:16px;height:16px;flex:none;fill:currentColor}
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
.select-option {
 display:grid;grid-template-columns:minmax(0,1fr) 20px;align-items:center;column-gap:10px;
 min-height:44px;padding:7px 10px;border-radius:var(--radius-field);cursor:pointer;overflow-wrap:anywhere;
}
.select-option+.select-option {margin-top:2px}
.select-option[aria-selected=true] {background:var(--accent-soft);color:var(--accent);font-weight:var(--weight-medium)}
.select-option[data-active=true] {background:var(--hover);outline:1px solid var(--control);outline-offset:-1px}
.select-option[aria-selected=true][data-active=true] {background:var(--accent-soft)}
.select-check {display:block;width:16px;height:16px;justify-self:center;visibility:hidden;fill:currentColor}
.select-option-label {min-width:0;white-space:normal;overflow-wrap:anywhere}
.select-option-detail {grid-column:1/-1;display:block;margin-top:3px;color:var(--muted);font-size:var(--type-caption);font-weight:var(--weight-regular);line-height:1.45;overflow-wrap:anywhere}
.select-option[aria-selected=true] .select-check {visibility:visible}
.select-option[aria-disabled=true] {color:var(--muted);cursor:not-allowed}
.select-group {padding:6px 10px;color:var(--muted);font-size:var(--type-caption);font-weight:var(--weight-medium)}
.select-popup-multiple {max-width:min(32em,var(--select-available-width,calc(100vw - 16px)));max-height:calc(100dvh - 16px)}
.select-popup-multiple .select-check {width:20px;height:20px;visibility:visible;border:0;border-radius:4px;padding:2px;outline:1px solid var(--control);outline-offset:-1px;fill:transparent}
.select-popup-multiple .select-option[aria-selected=true] .select-check {fill:currentColor;outline-color:currentColor}
.select-all {width:100%;justify-content:flex-start;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--rule);border-radius:0;margin-bottom:4px}
.select-draft-hint {font-size:var(--type-caption);line-height:1.5;color:var(--muted);margin:8px 10px}
.select-footer {display:flex;flex-wrap:wrap;gap:8px;padding:6px 10px;border-top:1px solid var(--rule)}
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
@media(prefers-reduced-motion:reduce) {.select-trigger::before {transition:none}}
`;
