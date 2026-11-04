export const periodFlowStyles = `
#filters {display:block;padding:8px 0;border:0;background:transparent;container:activity-filters / inline-size}
.filter-scroll {position:relative;max-width:100%;padding:4px}
.filter-scroll:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.period-controls {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));align-items:start;gap:8px;width:100%;min-width:0}
#filters .filter-scroll>.period-controls {
 --primary-basic-width:8.5rem;
 --primary-tool-width:11rem;
 --primary-outcome-width:calc(10.5rem + 44px + var(--select-field-gap));
 --primary-author-width:calc(8rem + 44px + var(--select-field-gap));
 display:flex;flex-wrap:wrap;
}
#filters :is(.primary-single-fields,.primary-multiple-fields) {display:flex;flex-wrap:wrap;align-items:start;gap:8px;min-width:0;max-width:100%}
#filters .primary-single-fields {flex:3 1 calc(2 * var(--primary-basic-width) + var(--primary-tool-width) + 16px)}
#filters .primary-multiple-fields {flex:2 1 calc(var(--primary-outcome-width) + var(--primary-author-width) + 8px)}
#filters .secondary-filters.period-controls {grid-template-columns:repeat(auto-fit,minmax(min(100%,10.5rem),1fr))}
#filters .period-controls :is(.filter-field,.result-filter-field) {display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;gap:var(--select-field-gap);width:100%;min-width:0;max-width:none}
#filters .primary-single-fields>.filter-field {flex:1 1 var(--primary-basic-width);width:auto;max-width:100%}
#filters .primary-single-fields>.filter-field:has(#toolFilter) {flex-basis:var(--primary-tool-width)}
#filters .primary-multiple-fields>.home-result-filter {flex:1 1 var(--primary-outcome-width);width:auto;max-width:100%}
#filters .primary-multiple-fields>.prompt-author-filter {flex:1 1 var(--primary-author-width);width:auto;max-width:100%}
#filters .period-controls .result-filter-field:has(.filter-clear:not([hidden])) {grid-template-columns:minmax(0,1fr) 44px}
#filters .period-controls .home-result-filter {display:block;margin:0;min-width:0}
#filters .period-controls :is(.filter-field,.result-filter-field)>label {grid-column:1/-1;grid-row:1;display:block;min-height:0;padding-inline:var(--select-value-inset);font-size:var(--type-small);font-weight:var(--weight-regular);line-height:1.5;white-space:normal;overflow-wrap:anywhere}
#filters .period-controls .local-filter-row {display:contents}
#filters .period-controls .filter-clear-slot {grid-area:2/2;justify-self:end;align-self:start}
#filters .period-controls .filter-clear-slot:has(>button[hidden]) {display:none}
#filters .period-controls .select-control {grid-column:1;grid-row:2;width:100%;max-width:none}
#filters .period-controls .select-trigger {grid-template-columns:minmax(0,1fr) 16px;padding:8px var(--select-value-inset);justify-content:space-between}
#filters .period-controls .select-value,#filters .period-controls .result-option-label {overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}
.more-filters {margin:4px;padding:0;border:0;background:transparent}
.more-filters>summary {min-height:44px;width:fit-content;padding:10px 4px;color:var(--accent);font-size:var(--type-control)}
.secondary-filters {padding-block:4px 8px}
#filterChips {--pill-fill:var(--paper);--pill-hover:var(--paper);--pill-pressed:var(--paper);display:flex;flex-wrap:wrap;gap:4px 8px}
#filterChips .filter-chip {max-width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere;text-align:start}
#filterChips .filter-chip .wire-icon {flex:none}
.service-focus {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin:8px 0;font-size:var(--type-small)}
.service-focus p {margin:0;max-width:100%;overflow-wrap:anywhere}
.service-focus button {min-height:44px;max-width:100%;white-space:normal;text-align:start}
.service-context-label {font-size:var(--type-small);color:var(--muted)}
#filters:has(#resultSummary[data-unavailable=true])>#resultFilterScope {position:static;width:auto;height:auto;padding:0;margin:8px 4px;overflow:visible;clip-path:none;white-space:normal}
#dateFields {display:grid;margin-top:8px;grid-template-columns:repeat(2,minmax(10em,10.5rem)) auto;width:max-content;max-width:100%;gap:8px 12px;align-items:end}
#dateFields label {display:grid;grid-template-rows:auto auto;gap:4px;min-width:0}
#dateFields label>span {display:flex;align-items:center;padding-inline:12px}
#dateFields input {min-height:44px;min-width:0;width:100%}
#dateFields button {min-height:44px}
#dateHint {grid-column:1/-1;margin:0;font-size:var(--type-caption);color:var(--muted)}
.date-actions {display:flex;flex-wrap:wrap;gap:4px;align-items:center}
#dateError {grid-column:1/-1;margin:0;font-size:.875rem;overflow-wrap:anywhere}
#dateError {color:var(--danger)}
.filter-tools {display:flex;width:fit-content;max-width:100%}
.filter-tools>.reset-view {margin-top:4px}
.stored-refresh {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-block:4px 0}
.stored-refresh>p {flex:1 1 20rem;min-width:0;margin:0;font-size:.875rem}
.stored-refresh>button {max-width:100%;white-space:normal;text-align:start}
#freshHelp .stored-refresh>p {margin:0}
.scope-reset-actions {margin-block:8px}
#homeView>.insight-header {padding:0 0 12px;justify-content:flex-start}
#periodResult {font-size:1rem;font-weight:600}
#periodHint {font-size:1rem;color:var(--muted);margin-top:4px}
.period-coverage {flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;min-width:0;padding:4px 16px;border-left:3px solid var(--warning);background:var(--paper);border-radius:var(--radius-small)}
.period-coverage p {font-size:1rem;margin:0;max-width:100%;overflow-wrap:anywhere}
.period-coverage a {display:inline-flex;min-height:44px;max-width:100%;align-items:center;white-space:normal;overflow-wrap:anywhere}
.fresh-activity {margin:0 0 16px;container:fresh-activity / inline-size}
.fresh-controls {display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:start;gap:8px 20px}
.fresh-controls>.ux-disabled-help {justify-self:start}
.fresh-result {grid-column:1/-1;min-width:0}
.fresh-result p {margin:0;font-size:var(--type-body)}
#freshStatus {font-weight:var(--weight-regular);overflow-wrap:anywhere}
#freshContextMessage {margin-top:4px;overflow-wrap:anywhere}
.fresh-result-meta {display:flex;flex-wrap:wrap;align-items:center;gap:0 16px}
.fresh-result-meta #freshChecked {font-size:.875rem}
.fresh-details {grid-column:2;grid-row:1;margin:0;min-width:0}
.fresh-help-body {max-width:75ch;padding-block:4px 8px;overflow-wrap:anywhere}
.fresh-reasons {margin:8px 0}
.fresh-reasons>div {margin-block:12px}
.fresh-reasons dt {font-weight:600}
.fresh-reasons dd {margin:4px 0 0}
#freshCoverageDetails {font-size:.875rem}
.fresh-context {display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;min-width:0}
.fresh-context p {margin:0;font-size:.875rem}
#freshIssues {display:inline-flex;align-items:center;min-height:44px}
#freshAwayLink {display:inline-flex;align-items:center;min-height:44px}
#freshAwayNotice[data-deferred-review=true]:not([hidden]) ~ #newDataNotice,
#workspace:has(#freshActivity[data-deferred-review=true]:not([hidden])) > #newDataNotice {display:none}
#checkActivity {min-height:var(--pill-height);white-space:normal;text-align:center;justify-self:start}
#freshHelp {border:0;background:transparent;padding:0;margin:0}
#freshHelp>summary {display:list-item;width:fit-content;min-height:44px;padding:10px 4px;color:var(--accent);font-size:.875rem;overflow-wrap:anywhere}
#freshHelp p {font-size:.875rem;max-width:75ch;margin:4px 0 8px}
@container fresh-activity (max-width:40rem) {
 .fresh-controls {grid-template-columns:minmax(0,1fr)}
 .fresh-details {grid-column:1;grid-row:2}
}
#freshStatus[data-severity=error] {color:var(--danger)}
@container activity-filters (max-width:45rem) {
 #dateFields {flex-basis:100%;width:100%;grid-template-columns:repeat(auto-fit,minmax(min(100%,10em),1fr))}
 .date-actions {grid-column:1/-1}
}
@media(max-width:699px) {
 .period-feedback {align-items:start}
}
`;
