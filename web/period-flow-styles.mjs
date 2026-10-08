export const periodFlowStyles = `
#filters {display:block;padding:8px 0;border:0;background:transparent;container:activity-filters / inline-size}
.period-controls {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;gap:12px 16px;max-width:48rem}
#filters .period-controls :is(.filter-field,.result-filter-field) {display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;gap:var(--select-field-gap);width:100%;min-width:0}
#filters .period-controls>.home-result-filter {display:block;margin:0;min-width:0}
#filters .period-controls :is(.filter-field,.result-filter-field)>.help-heading {
 grid-area:1/1;min-height:44px;align-self:stretch;align-items:center;
 padding-inline:var(--select-value-inset);padding-inline-end:calc(var(--select-value-inset) + 44px);
}
#filters .period-controls .local-filter-row {display:contents}
#filters .period-controls .filter-clear-slot {grid-area:1/1;justify-self:end;align-self:center}
#filters .period-controls .select-control {grid-column:1;grid-row:2;width:100%;max-width:none}
#filters .period-controls .select-trigger {padding:0 var(--select-value-inset)}
#dateFields {display:grid;grid-column:1/-1;grid-row:2;grid-template-columns:repeat(2,minmax(10em,10.5rem)) auto;width:max-content;max-width:100%;gap:8px 12px;align-items:end}
#dateFields label {display:grid;grid-template-rows:var(--select-help-target) auto;gap:4px;min-width:0}
#dateFields label>span {display:flex;align-items:center;padding-inline:12px}
#dateFields input {min-height:44px;min-width:0;width:100%}
#dateFields button {min-height:44px}
.date-actions {display:flex;flex-wrap:wrap;gap:4px;align-items:center}
#dateError {grid-column:1/-1;margin:0;font-size:.875rem;overflow-wrap:anywhere}
#dateError {color:var(--danger)}
.more-filters {margin-top:4px}
.filter-tools {display:grid;grid-template-columns:minmax(0,1fr);align-items:start;max-width:48rem}
.filter-tools>.more-filters {grid-area:1/1;min-width:0}
.filter-tools>.more-filters>summary {max-width:calc(100% - 11rem)}
.filter-tools>.reset-view {grid-area:1/1;justify-self:end;margin-top:4px}
.stored-refresh {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-block:12px}
.stored-refresh>p {flex:1 1 20rem;min-width:0;margin:0;font-size:.875rem}
.stored-refresh>button {max-width:100%;white-space:normal;text-align:start}
#freshHelp .stored-refresh>p {margin:0}
.scope-reset-actions {margin-block:8px}
.more-filters>summary {display:list-item;min-height:44px;width:fit-content;color:var(--accent);padding:10px 4px;font-size:var(--type-small)}
.secondary-filters {display:flex;flex-wrap:wrap;align-items:end;gap:12px;padding:16px;background:var(--paper);border-radius:var(--radius)}
.secondary-filters>.filter-field {flex:1 1 150px!important;width:auto!important;max-width:100%}
.period-feedback {margin:8px 0 24px;display:flex;flex-wrap:wrap;justify-content:flex-start;align-items:center;gap:12px 20px}
.home-period-summary #periodResult {font-size:var(--type-data-value);line-height:var(--leading-data-value)}
.home-period-summary #activityCount,.home-period-summary #activityUnit {font:inherit;color:inherit;letter-spacing:inherit}
.home-period-summary #periodHint {font-size:var(--type-small);line-height:1.5}
#homeView>.insight-header {padding:0 0 12px;justify-content:flex-start}
.period-feedback>div:first-child {min-width:0;max-width:100%;flex:0 1 auto;overflow-wrap:anywhere}
#periodResult {font-size:1rem;font-weight:600}
#periodHint {font-size:1rem;color:var(--muted);margin-top:4px}
.period-coverage {flex-basis:100%;padding:12px 16px;border-left:3px solid var(--warning);background:var(--paper);border-radius:var(--radius-small)}
.period-coverage p {font-size:1rem}
.period-coverage a {display:inline-flex;min-height:44px;align-items:center}
#periodActions {display:flex;align-items:center;gap:var(--pill-gap);min-width:0;max-width:100%;flex:0 1 auto}
#periodActions:empty,#periodActions:has(>#pageAction[hidden]) {display:none}
#periodActions a {min-height:44px}
.fresh-activity {margin:0 0 16px;container:fresh-activity / inline-size}
.fresh-controls {display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:start;gap:8px 20px}
.fresh-controls>.ux-disabled-help {justify-self:start}
.fresh-result {grid-column:1/-1;min-width:0}
.fresh-result p {margin:0;font-size:1rem}
#freshStatus {font-weight:600;overflow-wrap:anywhere}
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
.fresh-links {display:flex;flex-wrap:wrap;gap:var(--pill-gap);max-width:100%}
.fresh-links a,#freshIssues {display:inline-flex;align-items:center;min-height:44px}
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
@container activity-filters (max-width:44rem) {
 .period-controls {grid-template-columns:minmax(0,1fr)}
}
@container activity-filters (max-width:28rem) {
 .filter-tools>.more-filters,.filter-tools>.reset-view {grid-area:auto;justify-self:start}
 .filter-tools>.more-filters {width:100%}
 .filter-tools>.more-filters>summary {max-width:100%}
}
@media(max-width:699px) {
 .period-feedback {align-items:start}
 .secondary-filters>.filter-field {flex-basis:100%!important}
}
`;
