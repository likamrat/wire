export const analyzeLayoutStyles = `
.analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card,.bounded-native-summary .percentage-card {
 border:1px solid var(--surface-edge);border-radius:var(--radius);
 background:var(--paper);box-shadow:var(--panel-shadow);
}
.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card {background:transparent;border-color:transparent;box-shadow:none}
@media(forced-colors:active) {
 .analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card,.bounded-native-summary .percentage-card {border-color:CanvasText;box-shadow:none}
}
#workspace>#analyzePopulation {padding:16px 20px;margin-block:0 20px;max-width:none;min-width:0}
#analyzePopulation:not(:has(#periodComparisonSetup:not([hidden]),#filters:not([hidden]),#filterChips:not([hidden]):not(:empty),#freshActivity:not([hidden]),#collectionNotice:not([hidden]))) {display:none}
#analyzePopulation #filters {padding:0;background:none;border:0}
.filter-heading {display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:var(--type-control);font-weight:var(--weight-regular)}
.filter-heading>.wire-icon {width:20px;height:20px}
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
#homeView {container:analyze-view / inline-size}
.analyze-dashboard {min-width:0}
.analyze-dashboard[data-dashboard-layout=packed] {display:grid;grid-template-columns:minmax(32rem,36rem) minmax(0,1fr);grid-auto-rows:1px;gap:0 16px;align-items:start}
.analyze-dashboard[data-dashboard-layout=packed] .analyze-chart-grid,
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts,
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts .percentage-section,
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts .percentage-panels {display:contents}
.analyze-dashboard[data-dashboard-layout=packed] :is(.analyze-outcome-summary,.analyze-chart-main,#percentageCharts .percentage-card) {align-self:start;grid-column:auto}
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts .percentage-legend {row-gap:0}
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts [data-breakdown=models] {padding-block:8px}
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts [data-breakdown=models] .percentage-label {min-height:1.5rem}
.analyze-chart-grid {display:grid;grid-template-columns:minmax(32rem,36rem) minmax(0,1fr);gap:16px;align-items:start;min-width:0}
.analyze-outcome-summary {min-width:0;display:flex;flex-direction:column}
:is(#outcomeChart,.native-outcome-chart) {min-width:0;display:flex;flex:1}
:is(#outcomeChart,.native-outcome-chart)>.percentage-card {width:100%;padding:20px 20px 0;border:0;background:none;display:flex;flex-direction:column;container:outcome-card / inline-size}
#outcomeChart .percentage-card-heading {margin:0 0 4px;min-height:0}
:is(#outcomeChart,.native-outcome-chart) .percentage-content:not([data-unit-mode=separate]) {display:grid;grid-template-columns:minmax(0,var(--outcome-ring-size,13rem)) minmax(0,1fr);gap:0 16px;align-items:center;align-content:center;flex:1;padding-bottom:8px}
#outcomeChart .percentage-content:has(>.percentage-empty:only-child) {display:block}
:is(#outcomeChart,.native-outcome-chart) .percentage-visual {width:var(--outcome-ring-size,13rem);margin-inline:auto}
:is(#outcomeChart,.native-outcome-chart) .percentage-legend {grid-template-columns:minmax(0,1fr);gap:0}
:is(#outcomeChart,.native-outcome-chart) .percentage-legend-row {grid-template-columns:20px minmax(0,1fr) max-content;gap:8px}
:is(#outcomeChart,.native-outcome-chart) .percentage-value {gap:0 4px;grid-column:auto}
.analyze-chart-main {min-width:0;display:flex;flex-direction:column;overflow:visible}
.analyze-chart-main>.insight-header {padding:8px 16px;margin:0;border-bottom:1px solid transparent}
.analyze-chart-main .view-switch {display:flex;flex-wrap:wrap;gap:4px}
.analyze-chart-main .view-switch>button {flex:0 1 auto;overflow-wrap:normal}
#homeView .analyze-chart-main .chart-panel {border:0;background:none;box-shadow:none;max-inline-size:none;padding:12px 20px 8px;flex:1}
.analyze-chart-main .chart-heading {margin:0 0 8px;align-items:center}
#homeView #chart>.empty-state {padding:8px 0 12px;background:none;border:0;border-radius:0;text-align:start}
#homeView #chart>.empty-state>h3 {font:inherit;color:var(--muted)}
#homeView #chart>.empty-state>p {margin:8px 0 0}
#homeView :is(.chart-heading h2,.percentage-card h3) {text-transform:none;letter-spacing:0;font-size:var(--type-reading);font-weight:var(--weight-medium)}
.percentage-legend .wire-icon {width:var(--icon-utility-size);height:var(--icon-utility-size)}
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
#activityView>#activityListContext {display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:8px 16px;margin:0 0 16px;padding:0;border:0}
#activityListContext>#activityTitle {position:absolute}
#activityListSummary {grid-column:1;grid-row:1;align-self:center;justify-self:start;max-width:80ch;font:var(--weight-strong) var(--type-section)/var(--leading-section) var(--font);color:var(--ink)}
#activityListSummary:focus-visible {outline:2px solid var(--focus);outline-offset:4px;border-radius:2px}
.activity-list-scope {grid-column:1/-1;grid-row:2;max-width:90ch;font-size:var(--type-small);line-height:1.5;color:var(--muted)}
#activityListContext>.filter-field {grid-column:1/-1;margin-inline-start:0}
@container analyze-view (min-width:44rem) {
 #percentageCharts [data-breakdown=models] {grid-column:1/-1}
 #homeView .flat-comparison {max-block-size:44rem;overflow-y:auto;scrollbar-gutter:stable;overscroll-behavior:contain;padding:4px}
 #homeView .flat-comparison:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
}
@container analyze-view (min-width:72rem) {
 #percentageCharts .percentage-panels {grid-template-columns:repeat(3,minmax(0,1fr))}
 #percentageCharts [data-breakdown=models] {grid-column:auto}
}
@container analyze-view (max-width:64rem) {
 .analyze-chart-grid {grid-template-columns:minmax(0,1fr)}
 .analyze-dashboard[data-dashboard-layout=packed] {grid-template-columns:minmax(0,1fr)}
}
@container breakdown-card (min-width:30rem) {
 #percentageCharts .percentage-legend {grid-template-columns:24px minmax(0,14rem) minmax(2rem,1fr) max-content;column-gap:8px}
 #percentageCharts .percentage-tool-list {grid-template-columns:minmax(0,18rem) minmax(2rem,1fr) max-content}
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
@container outcome-card (max-width:30rem) {
 :is(#outcomeChart,.native-outcome-chart) .percentage-content:not([data-unit-mode=separate]) {grid-template-columns:minmax(0,1fr)}
 :is(#outcomeChart,.native-outcome-chart) .percentage-visual {margin-inline:auto}
}
@container outcome-card (max-width:18rem) {
 :is(#outcomeChart,.native-outcome-chart) .percentage-legend-row {grid-template-columns:20px minmax(0,1fr)}
 :is(#outcomeChart,.native-outcome-chart) .percentage-value {grid-column:2;justify-content:flex-start;text-align:start}
}
@media(max-width:699px) {
 #workspace>#analyzePopulation {padding:12px;margin-bottom:16px}
 #analyzePopulation .fresh-controls {align-items:start}
 #analyzePopulation .fresh-details {flex-basis:100%}
 #analyzePopulation .fresh-result {flex-basis:100%;padding-block:4px}
 :is(#outcomeChart,.native-outcome-chart)>.percentage-card,#percentageCharts .percentage-card {padding:16px}
 .analyze-chart-main .chart-panel {padding-inline:16px}
}
#homeView[data-empty=true]>.analyze-dashboard,
#homeView[data-empty=true]>.analyze-review {display:none}

.analyze-toolbar {display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:0 0 12px;min-width:0;container:analyze-entries / inline-size}
.analyze-reading:not(.period-comparing) #workspace>#analyzeToolbar {max-width:none}
#analyzeReferenceEntry:empty {display:none}
.analyze-toolbar[hidden] {display:none}
.analyze-toolbar:has(>#analyzeReferenceEntry[hidden]):has(>#openAnalyzeFilters[hidden]) {display:none}
#analyzeReferenceEntry {min-width:0}
#openChartReference,#openAnalyzeFilters {--action-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:max(44px,calc(1lh + 16px));padding:8px 12px;white-space:nowrap;overflow-wrap:normal;font-size:var(--type-control);line-height:var(--leading-control)}
#openAnalyzeFilters {--pill-border:var(--control);--pill-hover-border:var(--control);flex:none;color:var(--ink)}
#openAnalyzeFilters>.wire-icon {width:1rem;height:1rem;flex:none;color:inherit}
#analyzeRefresh {--action-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:44px;min-height:max(44px,calc(1lh + 16px));padding:8px 12px;white-space:nowrap;font-size:var(--type-control);line-height:var(--leading-control)}
#analyzeRefresh>.wire-icon {width:1rem;height:1rem;flex:none}
.analyze-toolbar>.ux-disabled-help {flex:none}
#analyzeRefresh:focus-visible {outline:none}
#analyzeRefresh:focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
#openChartReference:focus-visible,#openAnalyzeFilters:focus-visible {outline:none}
#openChartReference:focus-visible::before,#openAnalyzeFilters:focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
.analyze-filter-count {display:inline-flex;align-items:center;justify-content:center;min-width:1.5em;padding:0 .25em;border-radius:4px;background:var(--accent-soft);color:var(--ink);font-size:var(--type-caption);line-height:1.5;pointer-events:none}
.analyze-filter-count[hidden] {display:none}
@container analyze-entries (max-width:24rem) {
 #openChartReference,#openAnalyzeFilters,#analyzeRefresh {gap:6px;padding-inline:6px}
}
@container analyze-entries (max-width:19rem) {
 #analyzeRefreshLabel {display:none}
}
.analyze-filter-dialog {margin:0;inset:var(--analyze-panel-top,120px) clamp(16px,var(--analyze-panel-right,24px),max(16px,calc(100vw - 48rem - 16px))) auto auto;width:min(48rem,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - var(--analyze-panel-top,120px) - 16px);padding:0;border:1px solid var(--surface-divider);border-radius:var(--radius-dialog);background:var(--floating-paper);color:var(--ink);box-shadow:var(--surface-shadow);scroll-padding-top:76px}
.analyze-filter-dialog::backdrop {background:var(--scrim)}
@media(prefers-reduced-motion:no-preference) {
 .analyze-filter-dialog::backdrop {transition:background-color 320ms cubic-bezier(.2,0,0,1)}
 .analyze-filter-dialog[data-closing]::backdrop {background:transparent}
 @starting-style {.analyze-filter-dialog[open]::backdrop {background:transparent}}
}
.analyze-filter-panel {padding:16px 20px;min-width:0}
.analyze-filter-heading {position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 12px;background:var(--floating-paper)}
#analyzeFilterPanel #filterHeading {display:flex;margin:0;font-size:var(--type-section)}
#closeAnalyzeFilters {width:44px;height:44px;min-height:44px;padding:10px;flex:none}
#analyzeFilterPanel #filters {padding:0;border:0;background:none;box-shadow:none}
#analyzeFilterPanel .filter-scroll {padding:0;overflow:visible}
#analyzeFilterPanel #filters .filter-scroll>.period-controls,
#analyzeFilterPanel #filters .secondary-filters.period-controls {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:12px}
#analyzeFilterPanel #filters :is(.primary-single-fields,.primary-multiple-fields) {display:contents}
#analyzeFilterPanel .select-trigger-filter::before {inset:4px 0;box-shadow:none}
#analyzeFilterPanel #dateFields {width:100%;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))}
#analyzeFilterPanel #dateFields :is(#dateHint,#dateError) {grid-column:1/-1}
#analyzeFilterPanel .filter-utilities {margin-top:8px}
#analyzeFilterPanel .more-filters {margin:0}
#analyzeFilterPanel .secondary-filters {padding-top:8px}
#analyzeFilterPanel #appliedFilters {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin:12px 0 0}
#analyzeFilterPanel #appliedFilters:has(#filterChips:empty):has(#resetView:disabled) {display:none}
#analyzeFilterPanel #filterChips {margin:0;flex:0 1 auto;min-width:0}
#analyzeFilterPanel #filterChips:empty {display:none}
#analyzeFilterPanel #filterTools {flex:none}
#analyzeFilterPanel #resetView {display:inline-flex;align-items:center;gap:8px;min-height:44px;margin:0;font-size:var(--type-control);font-weight:var(--weight-regular)}
#analyzeFilterPanel #resetView>.wire-icon {width:1rem;height:1rem;flex:none;margin:0}
#analyzeFilterPanel #serviceFocus {margin:0 0 12px}
#analyzeFilterPanel .filter-chip {min-height:44px}
.analyze-view-controls {margin:16px 0 0;padding:12px 0 0;border:0;border-top:1px solid var(--surface-divider);min-width:0}
.analyze-view-controls>legend {padding-inline:0 8px;font-size:var(--type-reading);font-weight:var(--weight-strong)}
.analyze-view-controls>.muted {margin-bottom:8px;font-size:var(--type-small)}
.analyze-view-controls .view-switch {display:flex;flex-wrap:wrap;gap:4px}
.analyze-view-controls .view-switch>button {flex:0 1 auto;overflow-wrap:normal;white-space:normal}
#analyzeSourceContext {margin-top:12px}
#analyzeSourceContext:empty {display:none}
#analyzeSourceContext #periodCoverage {margin-top:8px}
.analyze-scope-summary {margin-top:12px;padding:10px 0 16px;border-top:1px solid var(--surface-divider);min-width:0}
#outcomeChart .analyze-scope-summary:not(:has(>:not([hidden],.visually-hidden))) {display:none}
.analyze-scope-caption,.analyze-scope-status,.analyze-scope-error {font-size:var(--type-small);line-height:1.5;max-width:none;overflow-wrap:anywhere}
.analyze-scope-caption {color:var(--muted)}
#comparisonAcceptedScope {max-width:none;overflow-wrap:anywhere}
.analyze-scope-parts {display:flex;flex-wrap:wrap;gap:var(--space-sm) var(--space-lg)}
.analyze-scope-part {position:relative;min-width:0;max-width:100%;overflow-wrap:anywhere}
#analyzeSourceCoverage .session-coverage {margin:8px 0 0}
.analyze-scope-status {margin-bottom:8px}
.analyze-scope-error {display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;color:var(--danger)}
.analyze-scope-error[hidden] {display:none}
.analyze-scope-error>.wire-icon {width:20px;height:20px;flex:none;color:inherit}
#analyzeEmptyScope .analyze-scope-summary {margin:0 0 16px;padding:12px 16px;border:1px solid var(--surface-edge);border-radius:var(--radius);background:var(--paper)}
.analyze-reading:not(.period-comparing) .page-heading {margin:0;min-height:0}
.analyze-reading:not(.period-comparing) .page-heading>div:first-child,
.analyze-reading:not(.period-comparing) #activityView:has(#activityListContext) #activityTitle {position:absolute!important;width:1px;height:1px;padding:0;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.analyze-reading:not(.period-comparing) #activityView {position:relative;margin-top:24px}
.analyze-reading:not(.period-comparing) #activityView>.section-heading {margin:0;padding:0;border:0}
.analyze-reading:not(.period-comparing) #homeView .analyze-chart-main>.insight-header {display:none}
.analyze-reading:not(.period-comparing) #workspace>#analyzePopulation {display:none}
.analyze-reference {margin-top:24px;min-width:0}
.analyze-reference[hidden] {display:none}
.analyze-reference .chart-actions {display:block}
.analyze-reference #meaning>summary {min-height:44px;align-content:center;cursor:pointer}
.analyze-tools {margin-top:20px;padding-top:16px;border-top:1px solid var(--surface-divider);min-width:0}
.analyze-tools>.navigation-group-label {font-size:var(--type-caption);font-weight:var(--weight-regular)}
.analyze-tool-row {position:relative;isolation:isolate;min-width:0}
/* The sibling glyph must paint above the action's own hover/pressed surface. */
.analyze-tool-row>svg {position:absolute;z-index:1;left:10px;top:50%;transform:translateY(-50%);width:24px;height:24px;color:var(--muted);pointer-events:none}
.analyze-tool-row:has(>.analyze-tool-action:is(:hover,:focus-visible,:active,[aria-expanded=true]))>svg {color:var(--ink)}
.analyze-tool-row:not(:has(.analyze-tool-action)),.analyze-tool-row:has(>.analyze-tool-action[hidden]) {display:none}
.period-comparing .analyze-tool-row:has(#createSessionReport) {display:none}
#analyzeTools .analyze-tool-action {display:flex;align-items:center;justify-content:flex-start;min-height:44px;width:100%;max-width:13rem;padding:8px 10px 8px 44px;font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-regular);text-align:left;white-space:normal;overflow-wrap:normal;border:0;border-radius:var(--radius-control);background:transparent;box-shadow:none;text-decoration:none}
#analyzeTools .analyze-tool-action::before {border:0;box-shadow:none;background:transparent}
#analyzeTools .analyze-tool-action[aria-expanded=true] {background:var(--accent-soft)}
#analyzeTools .analyze-tool-action:hover {background:var(--hover)}
#analyzeTools .analyze-tool-action:active {background:var(--pill-pressed)}
#analyzeReturnActions:empty {display:none}
#analyzeReturnActions #contextReturn>.button-link {min-height:44px;width:100%;max-width:13rem;white-space:normal;text-align:left}
:is(#outcomeChart,.native-outcome-chart) .percentage-visual {position:relative}
.percentage-total {position:absolute;inset:0 0 auto;aspect-ratio:1;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none;gap:2px}
.percentage-total-value {font-size:1.875rem;line-height:1.1;font-variant-numeric:tabular-nums;font-weight:var(--weight-strong)}
.percentage-total-unit {font-size:var(--type-small);line-height:var(--leading-caption);color:var(--muted)}
.percentage-total[data-length=long] .percentage-total-value {font-size:1.25rem}
.percentage-total[data-length=wide] {position:static;aspect-ratio:auto}
:is(#outcomeChart,.native-outcome-chart) .percentage-visual:has(.percentage-total[data-length=wide]) {width:100%}
:is(#outcomeChart,.native-outcome-chart) .percentage-visual:has(.percentage-total[data-length=wide])>svg {width:min(13rem,100%);display:block;margin-inline:auto}
.percentage-total[data-length=wide] .percentage-total-value {font-size:var(--type-data-value);overflow-wrap:anywhere}
.percentage-evidence-unit {display:block;text-align:center;font-size:var(--type-caption);line-height:1.4;margin-top:4px;color:var(--muted)}
:root[data-navigation=collapsed] .app-sidebar #analyzeTools .analyze-tool-action {width:44px;max-width:44px;padding:10px;font-size:0}
:root[data-navigation=collapsed] .app-sidebar #analyzeTools>.navigation-group-label {height:0;margin:0;padding:0;overflow:hidden}
@media(max-width:699px) {
 .analyze-filter-dialog {inset:auto 0 0;width:100%;max-height:90dvh;max-width:100%;border-radius:var(--radius-dialog) var(--radius-dialog) 0 0}
 .analyze-filter-panel {padding:16px}
 #analyzeFilterPanel #filters :is(.filter-scroll>.period-controls,.secondary-filters.period-controls) {grid-template-columns:minmax(0,1fr)}
 .analyze-scope-caption,.analyze-scope-status {font-size:var(--type-small)}
 #analyzeTools .analyze-tool-action {max-width:none}
}
@media(forced-colors:active) {
 .analyze-filter-dialog,.analyze-scope-summary,.analyze-tools,.analyze-view-controls {border-color:CanvasText;box-shadow:none}
 .analyze-filter-count {border:1px solid CanvasText}
}
`;
