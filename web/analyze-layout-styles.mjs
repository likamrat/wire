export const analyzeLayoutStyles = `
.analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card {
 border:1px solid var(--surface-edge);border-radius:var(--radius);
 background:var(--paper);box-shadow:var(--panel-shadow);
}
@media(forced-colors:active) {
 .analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card {border-color:CanvasText;box-shadow:none}
}
#workspace>#analyzePopulation {padding:16px 20px;margin-block:0 20px;max-width:none;min-width:0}
#analyzePopulation:not(:has(#filters:not([hidden]),#filterChips:not([hidden]):not(:empty),#freshActivity:not([hidden]),#collectionNotice:not([hidden]))) {display:none}
#analyzePopulation #filters {padding:0;background:none;border:0}
.filter-heading {display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:var(--type-control);font-weight:var(--weight-regular)}
.filter-heading>.wire-icon {width:20px;height:20px}
#analyzeRefresh {display:inline-flex;align-items:center}
#analyzeRefresh:empty {display:none}
#workspace>.page-heading:has(#analyzeRefresh:not([hidden])) {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center}
#analyzePopulation .applied-filters {display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;min-width:0}
#analyzePopulation .applied-filters>#filterChips {flex:0 1 auto;min-width:0;margin:0}
#analyzePopulation .applied-filters:has(#filterChips:empty):has(#resetView:disabled) {display:none}
#analyzePopulation .applied-filters:has(#filterChips:empty)>#filterChips {display:none}
#analyzePopulation .filter-tools {flex:none}
#analyzePopulation .filter-scroll {padding:0}
#analyzePopulation .period-controls {grid-template-columns:repeat(auto-fit,minmax(min(100%,10.5rem),1fr))}
#analyzePopulation .filter-utilities {display:flex;flex-wrap:wrap;align-items:start;gap:0 var(--space-md);margin-top:4px}
#analyzePopulation .more-filters {margin:0;min-width:0;max-width:100%}
#analyzePopulation .more-filters[open] {flex-basis:100%}
#analyzePopulation .more-filters>summary {padding-inline:8px;border-radius:12px}
#analyzePopulation .more-filters>summary:hover {background:var(--hover)}
#analyzePopulation .filter-tools>.reset-view {margin:0}
#analyzePopulation #filterChips:empty {display:none}
#analyzePopulation #filterChips:not(:empty) {margin:8px 0}
#analyzePopulation .filter-tools:has(>[hidden]) {display:none}
#analyzePopulation .fresh-activity {margin:4px 0 0;padding:0;border:0}
#analyzePopulation .fresh-activity:has(.fresh-details[hidden]):has(.fresh-result[hidden]) {display:none}
#analyzePopulation .fresh-controls {display:flex;flex-wrap:wrap;align-items:start;gap:0 16px}
#analyzePopulation .fresh-controls>.ux-disabled-help {flex:none}
#analyzePopulation .fresh-details {display:block;min-width:0;flex:1 1 16rem}
#analyzePopulation .fresh-result {flex:0 1 100%;padding-block:4px}
#analyzePopulation .fresh-result p {font-size:var(--type-small);font-weight:var(--weight-regular)}
#analyzePopulation #freshHelp {width:100%}
#analyzePopulation .fresh-help-body {max-width:none;padding:12px 16px;background:var(--canvas);border:1px solid transparent;border-radius:var(--radius-small)}
#analyzePopulation .fresh-help-body>p {max-width:80ch}
#analyzePopulation #collectionNotice {margin:0;padding:0;gap:4px 12px;background:none;border:0}
#analyzePopulation #collectionNotice p {font-size:var(--type-small)}
#workspace>#periodFeedback.home-period-summary {margin:0 0 16px;gap:8px 24px;justify-content:space-between;max-width:none}
#periodFeedback #periodResult {font-size:var(--type-data-value);line-height:var(--leading-data-value)}
#periodFeedback #periodHint {margin-top:2px}
#homeView {container:analyze-view / inline-size}
.analyze-dashboard {min-width:0}
.analyze-chart-grid {display:grid;grid-template-columns:minmax(20rem,24rem) minmax(0,1fr);gap:16px;align-items:stretch;min-width:0}
.analyze-outcome-summary {min-width:0;display:flex;flex-direction:column}
#outcomeChart {min-width:0;display:flex;flex:1}
#outcomeChart>.percentage-card {width:100%;padding:20px 20px 0;border:0;background:none;display:flex;flex-direction:column;container:outcome-card / inline-size}
#outcomeChart .percentage-card-heading {margin:0 0 12px;min-height:0}
#outcomeChart .percentage-content {display:grid;grid-template-columns:minmax(0,1fr);gap:8px;align-items:center;align-content:center;flex:1;padding-bottom:12px}
#outcomeChart .percentage-content:has(>.percentage-empty:only-child) {display:block}
#outcomeChart .percentage-visual {width:8rem;margin-inline:auto}
#outcomeChart .percentage-legend {grid-template-columns:minmax(0,1fr);gap:4px}
#outcomeChart .percentage-legend-row {grid-template-columns:20px minmax(0,1fr) max-content;gap:8px}
#outcomeChart .percentage-value {gap:0 4px;grid-column:auto}
.analyze-chart-main {min-width:0;display:flex;flex-direction:column;overflow:visible}
.analyze-chart-main>.insight-header {padding:8px 16px;margin:0;border-bottom:1px solid transparent}
.analyze-chart-main .view-switch {display:flex;flex-wrap:wrap;gap:4px}
.analyze-chart-main .view-switch>button {flex:0 1 auto;overflow-wrap:normal}
#homeView .analyze-chart-main .chart-panel {border:0;background:none;box-shadow:none;max-inline-size:none;padding:12px 20px 8px;flex:1}
.analyze-chart-main .chart-heading {margin:0 0 8px;align-items:center}
#homeView :is(.chart-heading h2,.percentage-card h3) {text-transform:none;letter-spacing:0;font-size:var(--type-section)}
.analyze-chart-main #chartFooter {margin-top:8px;line-height:1.5}
.analyze-chart-main #chartFooter:empty {display:none}
.analyze-chart-main #chartFooter .chart-size-note {font-size:var(--type-caption)}
#percentageCharts .percentage-section {margin-block:20px 16px}
#percentageCharts .percentage-panels {gap:16px;align-items:start}
#percentageCharts .percentage-card {padding:16px 20px}
#percentageCharts .percentage-card-heading {margin-bottom:4px;min-height:0}
#percentageCharts .percentage-card {container:breakdown-card / inline-size}
#percentageCharts .percentage-legend {gap:4px}
#percentageCharts .percentage-gap-list {margin:4px 0 0;padding-inline-start:28px;font-size:var(--type-caption);color:var(--muted)}
#percentageCharts .percentage-gap-list>div {padding-block:2px}
#percentageCharts [data-breakdown=models] .percentage-label {min-height:36px}
#homeView .percentage-denominator {margin-top:4px;font-size:var(--type-caption)}
#homeView .percentage-exact>summary {font-size:var(--type-small)}
.analyze-review {margin-block:var(--space-lg)}
.analyze-review #homeInsights .assessment-heading h2 {font-size:var(--type-reading);line-height:var(--leading-ui)}
#homeFindings {padding:12px 20px 16px;border-top:1px solid var(--rule);min-width:0}
#homeFindings:has(>.assessment-findings[hidden]) {display:none}
#homeFindings .assessment-findings {margin:0;font-size:var(--type-small)}
#homeFindings .assessment-finding-limit {font-size:var(--type-caption)}
#homeFindings .assessment-widget-links {display:flex;flex-wrap:wrap;gap:4px 20px;align-items:center}
#homeFindings .assessment-widget-links[hidden] {display:none}
#homeFindings .assessment-widget-link {display:flex;flex-wrap:wrap;gap:0 8px;align-items:center;min-width:0}
#homeFindings .assessment-widget-link>button {color:var(--accent);padding-inline:0;border-color:transparent;font-size:var(--type-small)}
#homeFindings .assessment-widget-status {color:var(--muted);font-variant-numeric:tabular-nums}
#homeFindings .assessment-widget-status.negative {color:var(--performance-red)}
#homeFindings .assessment-widget-status+.assessment-widget-status::before {content:"\\00b7";margin-right:8px;color:var(--muted)}
#homeFindings .assessment-widget-links>.assessment-finding-limit {flex-basis:100%;margin:0}
.analyze-review-details {min-width:0;max-width:100%;margin-top:var(--space-sm)}
.analyze-review-details>summary {width:fit-content;max-width:100%;min-height:44px;align-content:center;cursor:pointer;color:var(--accent);font-size:var(--type-control);overflow-wrap:anywhere}
.analyze-review #homeInsights {margin:var(--space-sm) 0 0}
.analyze-review #homeInsights>.assessment-scope {margin:0 0 var(--space-lg);padding:0;border:0;max-width:72ch;font-size:var(--type-body)}
.analyze-review #homeInsights .assessment-summary>.assessment-heading {justify-content:flex-start}
.analyze-review .assessment-empty-review {font-size:var(--type-body)}
#homeView>.chart-actions {margin:0}
#homeView>.chart-actions #meaning>summary,#homeView>#serviceDefinitions>summary {
 font-size:var(--type-small);font-weight:var(--weight-regular);color:var(--muted);padding-block:8px;
}
#homeView>#serviceDefinitions {margin-top:0}
#meaning #percentageData {display:grid;grid-template-columns:minmax(0,1fr);gap:16px;margin-block:16px}
#meaning .percentage-data {min-width:0}
#meaning .percentage-data h3 {margin-bottom:4px}
#meaning #tableDisclosure {margin-top:16px}
#meaning #chartReadingNotes dl {margin:8px 0}
#meaning #chartReadingNotes dt {font-weight:var(--weight-strong);margin-top:12px}
#meaning #chartReadingNotes dd {margin:2px 0 0}
#meaning>section+section {margin-top:16px}
#activityView {margin-top:24px}
.reader-response-timing {min-width:0;margin:var(--space-sm) 0 var(--space-md);font-size:var(--type-body);line-height:var(--leading-ui);overflow-wrap:anywhere}
.reader-response-timing>.response-timing {display:grid;gap:4px;min-width:0}
.reader-response-timing dt {font-weight:var(--weight-strong)}
.reader-response-timing dd {margin:0;font-weight:var(--weight-regular)}
.response-timing data {font-variant-numeric:tabular-nums}
#activityView>.section-heading {padding-bottom:8px;border-bottom:1px solid transparent;gap:8px 16px}
#activityView .analyze-result-actions {margin-block:8px}
@container analyze-view (min-width:44rem) {
 #percentageCharts [data-breakdown=models] {grid-column:1/-1}
 #homeView .flat-comparison {max-block-size:44rem;overflow-y:auto;scrollbar-gutter:stable;overscroll-behavior:contain;padding:4px}
 #homeView .flat-comparison:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
}
@container analyze-view (min-width:72rem) {
 #percentageCharts .percentage-panels {grid-template-columns:repeat(3,minmax(0,1fr))}
 #percentageCharts [data-breakdown=models] {grid-column:auto}
}
@container analyze-view (max-width:54rem) {
 .analyze-chart-grid {grid-template-columns:minmax(0,1fr)}
 #outcomeChart .percentage-content {grid-template-columns:minmax(0,8rem) minmax(0,1fr)}
}
@container breakdown-card (min-width:30rem) {
 #percentageCharts .percentage-legend {grid-template-columns:24px minmax(0,14rem) minmax(2rem,1fr) max-content;column-gap:8px}
 #percentageCharts .percentage-tool-list {grid-template-columns:minmax(0,14rem) minmax(2rem,1fr) max-content}
 #percentageCharts .percentage-legend-row {grid-column:1/-1;grid-template-columns:subgrid}
 #percentageCharts .percentage-bar-track {grid-column:3;grid-row:1}
 #percentageCharts .percentage-tool-list .percentage-bar-track {grid-column:2}
 #percentageCharts .percentage-value {grid-column:4;grid-row:1}
 #percentageCharts .percentage-tool-list .percentage-value {grid-column:3}
}
@container breakdown-card (min-width:16rem) and (max-width:29.999rem) {
 #percentageCharts .percentage-legend-row {grid-template-columns:24px minmax(0,1fr) max-content}
 #percentageCharts .percentage-tool-list .percentage-legend-row {grid-template-columns:minmax(0,1fr) max-content}
 #percentageCharts .percentage-value {grid-column:3;justify-content:flex-end;text-align:end}
 #percentageCharts .percentage-tool-list .percentage-value {grid-column:2}
}
@container outcome-card (max-width:24rem) {
 #outcomeChart .percentage-content {grid-template-columns:minmax(0,1fr)}
 #outcomeChart .percentage-visual {margin-inline:auto}
}
@container outcome-card (max-width:18rem) {
 #outcomeChart .percentage-legend-row {grid-template-columns:20px minmax(0,1fr)}
 #outcomeChart .percentage-value {grid-column:2;justify-content:flex-start;text-align:start}
}
@media(max-width:699px) {
 #workspace>#analyzePopulation {padding:12px;margin-bottom:16px}
 #analyzePopulation .fresh-controls {align-items:start}
 #analyzePopulation .fresh-details {flex-basis:100%}
 #analyzePopulation .fresh-result {flex-basis:100%;padding-block:4px}
 #outcomeChart>.percentage-card,#percentageCharts .percentage-card {padding:16px}
 .analyze-chart-main .chart-panel {padding-inline:16px}
}
#homeView[data-empty=true]>.analyze-dashboard,
#homeView[data-empty=true]>.analyze-review {display:none}
`;
