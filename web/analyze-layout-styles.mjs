const readings = ":is(#percentageCharts,.analyze-ordered-widgets) .percentage-content .percentage-tool-list";
const pairs = `${readings}:has(>:nth-child(4))`;
const chartAction = ":is(.analyze-trend-link,.usage-date-link,.population-link)";
const breakdownContent = ":is(#percentageCharts,.analyze-ordered-widgets) .percentage-content";

export const analyzeLayoutStyles = `
.usage-question-controls {display:flex;align-items:end;flex-wrap:wrap;gap:var(--space-sm) var(--space-md);margin-block:var(--space-sm) var(--space-md);min-width:0}
.usage-question-controls>.report-form-field:not([hidden]) {display:grid;gap:4px;min-width:0;max-width:100%;color:var(--muted);font-size:var(--type-small)}
.usage-question-controls :is(select,.select-trigger) {min-width:0;max-width:100%;min-height:44px;color:var(--ink)}
.analyze-usage {min-width:0;padding:var(--widget-heading-inset) 20px var(--space-2xl);background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius-small);container:usage-card / inline-size}
.analyze-usage:has(.token-history) {padding-bottom:clamp(20px,calc(20px + var(--axis-scrollbar-size,0px)),32px)}
.analyze-dashboard>.analyze-usage {grid-column:1/-1}
.wire-frontend-react .analyze-dashboard>.analyze-usage {margin-top:16px}
.token-history {display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:10px;color:var(--ink);font-variant-numeric:tabular-nums;font-size:var(--type-small)}
.token-history-scale {display:grid;position:relative;height:var(--plot-height);color:var(--muted);text-align:end}
.token-history-scale span {grid-area:1 / 1;position:relative;align-self:start;transform:translateY(-50%)}
.token-history {--plot-height:clamp(8.5rem,11vw,11rem);position:relative}
.token-history-scroll {min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-inline:contain;padding-bottom:8px}
.token-history-strip {display:grid;width:max-content;min-width:100%}
.token-history-plot {position:relative;height:var(--plot-height);min-width:0;cursor:default}
.token-history-plot svg {width:100%;height:100%;display:block;overflow:visible}
.token-history-scroll:has(.usage-date-slider:focus-visible) {outline:2px solid var(--focus,var(--accent));outline-offset:2px}
.token-grid {stroke:var(--screen-grid);stroke-width:1}.token-axis {stroke:var(--muted);stroke-width:1}
.token-column {fill:var(--accent);transform-box:fill-box;transform:translateX(-50%)}
.token-zero {fill:var(--accent)}
.token-hover-point {fill:var(--paper);stroke:var(--accent);stroke-width:2;opacity:0}
.token-history[data-inspecting] .token-hover-point {opacity:1}
.usage-date-slider {position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;pointer-events:none}
.token-history-dates {display:grid;grid-template-columns:repeat(var(--days),minmax(max-content,1fr));color:var(--muted)}
.token-history-dates time {min-width:3.75em;padding-inline:.35em;box-sizing:border-box;text-align:center;white-space:nowrap}
.token-history-pages {grid-column:1/-1;display:flex;justify-content:space-between}
.token-day-reading,#evidence-tooltip[data-tone=chart] {padding:6px var(--space-md);background:var(--floating-paper);color:var(--ink);border:1px solid var(--surface-divider);border-radius:var(--radius-small);box-shadow:var(--surface-shadow);font-size:var(--type-small);font-weight:var(--weight-regular)}
.token-day-reading {position:absolute;grid-column:2;z-index:var(--layer-tooltip);display:grid;gap:2px;width:max-content;max-width:min(18rem,100%);box-sizing:border-box;overflow-wrap:anywhere;opacity:0;pointer-events:none}
#evidence-tooltip[data-tone=chart] {--tooltip-gap:var(--space-md);max-width:min(18rem,calc(100% - 2 * var(--tooltip-gap)));white-space:pre-line}
#evidence-tooltip[data-tone=chart]::first-line {color:var(--accent)}
.token-history[data-inspecting] .token-day-reading {opacity:1}
.token-history[data-day-actionable] .token-day-reading a {pointer-events:auto}
.token-day-date {color:var(--muted)}.token-day-date a {display:inline-flex;align-items:center;min-height:24px}
@media(pointer:coarse){.token-day-date a {min-height:44px}}
.usage-chip.usage-missing {color:var(--muted);border-color:transparent;background:transparent}
.context-sidebar-header .reader-token-jump {margin-inline-end:auto;display:inline-flex;align-items:center;gap:5px;min-height:44px;padding:3px 6px;color:var(--accent);background:transparent;border:0;box-shadow:none;font-size:var(--type-small)}
.reader-token-jump .wire-icon {width:1em;height:1em;flex:none}
#analyzeUsageContent>p {margin:10px 0 0;text-box:trim-end cap alphabetic}
.usage-chip {margin-inline-start:auto;align-self:start;white-space:nowrap;font-size:var(--type-small);font-variant-numeric:tabular-nums;color:var(--ink);background:var(--paper);border:1px solid var(--rule);border-radius:6px;padding:2px 7px}
.usage-switch,.usage-sort {display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.usage-switch {margin-block:6px}
.usage-sort {justify-self:end}.usage-sort.select-field {display:inline-flex;flex-direction:row;align-items:center;gap:8px}
@media(min-width:761px){
 #activityView>#activityListContext:has(.usage-sort){grid-template-columns:minmax(0,1fr) auto auto;align-items:center}
 #activityListContext>.usage-sort {grid-column:3;grid-row:1}
}
.usage-reading {font-variant-numeric:tabular-nums}
.usage-table-wrap {max-width:100%;overflow:auto}
.usage-table {width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.usage-table :is(th,td){padding:6px;text-align:end;border-bottom:1px solid var(--rule)}.usage-table :first-child:is(th,td){text-align:start}
.usage-context {padding:10px;background:var(--paper);border-radius:6px}
.usage-timeline {padding-inline-start:1.5em;overflow-wrap:anywhere}.usage-timeline li {padding-block:5px}
.usage-timeline li>span,.usage-timeline li>time{display:block}.usage-timeline time{font-size:var(--type-small)}
@property --analyze-sweep {syntax:"<angle>";initial-value:360deg;inherits:false}
#outcomeChart .percentage-ring[data-building] {mask-image:conic-gradient(black var(--analyze-sweep),transparent 0)}
/* Keep the exact, accessible value and its width in place; only paint the temporary figure. */
:is(.percentage-total-value,.percentage-value>*,.dimensional-count)[data-build-value] {-webkit-text-fill-color:transparent}
:is(.percentage-total-value,.percentage-value>*)[data-build-value] {position:relative}
:is(.percentage-total-value,.percentage-value>*,.dimensional-count)[data-build-value]::after {content:attr(data-build-value) / "";position:absolute;inset:0;pointer-events:none;-webkit-text-fill-color:currentColor;text-align:inherit;font:inherit;font-variant-numeric:tabular-nums}
.dimensional-count[data-build-value]::after {display:grid;place-items:center}
.analyze-dashboard[data-custom-order]:not([hidden]) {display:block!important}
.analyze-dashboard[data-custom-order]>.analyze-chart-grid,.analyze-dashboard[data-custom-order]>#percentageCharts {display:none!important}
.analyze-ordered-widgets {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:16px}
.analyze-dashboard .analyze-ordered-widgets>[data-home-section] {grid-column:auto;grid-row:auto;min-width:0;margin:0}
#homeView .analyze-ordered-widgets>#activityView {margin:0}
.analyze-ordered-widgets[data-dashboard-layout=packed],#frontendBreakdowns .percentage-panels[data-dashboard-layout=packed] {grid-auto-rows:1px;row-gap:0}
.analyze-dashboard .analyze-ordered-widgets>[data-full-row] {grid-column:1/-1}
.analyze-dashboard .analyze-ordered-widgets>:is(.analyze-chart-main,.analyze-outcome-summary,.percentage-card) {border:1px solid var(--surface-edge);border-radius:var(--radius-small)}
.analyze-ordered-widgets>.percentage-card:not(.analyze-usage) {padding:var(--widget-heading-inset) 16px 16px;background:var(--paper);container:breakdown-card / inline-size}
@container analyze-view (max-width:60rem){.analyze-ordered-widgets {grid-template-columns:minmax(0,1fr)}}
@media(hover:hover) and (pointer:fine) {
    body.analyze-reading #activityView #activityList .activity-card:hover {background:color-mix(in srgb,var(--accent) 6%,var(--paper))}
}
.analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card,.bounded-native-summary .percentage-card {
 border:1px solid var(--surface-edge);border-radius:var(--radius);
 background:var(--paper);box-shadow:var(--panel-shadow);
}
.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card {background:var(--screen-plot);box-shadow:none}
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
.analyze-dashboard,#frontendBreakdowns {--widget-heading-inset:16px}
.analyze-dashboard[data-dashboard-layout=packed] {display:grid;grid-template-columns:minmax(0,1fr) minmax(32rem,36rem);grid-auto-rows:1px;gap:0 16px;align-items:start}
.analyze-dashboard[data-dashboard-layout=packed]:not([data-custom-order])>#activityView {grid-column:1/-1;min-width:0;margin:0}
.analyze-dashboard[data-dashboard-layout=packed]>.analyze-chart-grid {grid-column:1/-1}
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts,
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts .percentage-section,
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts .percentage-panels {display:contents}
.analyze-dashboard[data-dashboard-layout=packed]:not([data-custom-order]) #percentageCharts .percentage-card {align-self:start;grid-column:auto}
.analyze-dashboard[data-dashboard-layout=packed] #percentageCharts .percentage-legend {row-gap:0}
.analyze-chart-grid {display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0}
.analyze-outcome-summary {min-width:0;display:flex;flex-direction:column}
:is(#outcomeChart,.native-outcome-chart) {min-width:0;display:flex;flex:1}
:is(#outcomeChart,.native-outcome-chart)>.percentage-card {width:100%;padding:20px 20px 0;border:0;background:none;display:flex;flex-direction:column;container:outcome-card / inline-size}
#outcomeChart .percentage-card-heading {margin:0 0 4px;min-height:0}
@container outcome-card (min-width:56rem) {
 #outcomeChart .percentage-content[data-unit-mode=single]>.percentage-legend {grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:8px 16px}
 #outcomeChart .percentage-content[data-unit-mode=single] .percentage-legend-row {grid-template-columns:auto minmax(0,1fr);align-content:center;justify-items:start}
 #outcomeChart .percentage-content[data-unit-mode=single] .percentage-value {grid-column:2;justify-self:start;padding-inline:6px}
}
#outcomeChart>.percentage-card {padding-block:var(--widget-heading-inset) var(--space-lg)}
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
#homeView .analyze-chart-main .chart-panel {border:0;background:none;box-shadow:none;max-inline-size:none;padding:var(--widget-heading-inset) 20px var(--space-2xl);flex:1}
/* Full date line boxes and the inner scroll clearance share the existing footer inset. */
#homeView .analyze-chart-main:has(.dimensional-scroll) .chart-panel {padding-bottom:clamp(20px,calc(20px + var(--axis-scrollbar-size,0px)),32px)}
#chart .dimensional-scroll {padding-block-end:8px}
#chart .dimensional-time-labels {min-height:0}
#chart .dimensional-time-labels>* {padding-block-end:0}
.analyze-chart-main .chart-heading {margin:0 0 8px;align-items:center}
:is(.chart-heading,.percentage-card-heading):has(>.analyze-trend-link:not([hidden])){display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:0 12px}
:is(.chart-heading,.percentage-card-heading):has(>.analyze-trend-link)>:is(h2,h3){grid-area:1 / 1;margin:0;min-width:0;overflow-wrap:anywhere;line-height:var(--leading-section)}
.percentage-card-heading:has(>.analyze-trend-link)>.percentage-denominator{grid-column:1/-1;grid-row:2}
.analyze-trend-link:not([hidden]){grid-area:1 / 2;align-self:start;justify-self:end;display:inline-flex;align-items:center;min-height:44px;font-size:var(--type-reading);line-height:var(--leading-control);white-space:nowrap}
/* Anchor the title's cap edge independently of wrapping and the 44px action target. */
@supports(text-box:trim-start cap alphabetic) {
 :is(.chart-heading,.percentage-card-heading):has(>.analyze-trend-link)>:is(h2,h3) {align-self:start;margin-block-start:var(--space-lg);text-box:trim-start cap alphabetic}
}
${chartAction} {position:relative;isolation:isolate;padding-inline:var(--space-sm);border-radius:var(--radius-control);text-decoration:none}
${chartAction}::before {content:"";position:absolute;inset:var(--control-face-inset) 0;border-radius:inherit;z-index:-1;pointer-events:none}
${chartAction}:hover::before {background:var(--hover)}
${chartAction}:active::before {background:var(--pill-pressed)}
${chartAction}:focus-visible {outline:none}
${chartAction}:focus-visible::before {outline:2px solid var(--focus);outline-offset:1px}
@container (max-width:16rem){
 :is(.chart-heading,.percentage-card-heading):has(>.analyze-trend-link:not([hidden])){grid-template-columns:minmax(0,1fr)}
 .analyze-trend-link:not([hidden]){grid-area:2 / 1;justify-self:start}
 .percentage-card-heading:has(>.analyze-trend-link)>.percentage-denominator{grid-row:3}
}
.analyze-trend-decision{max-width:min(32rem,calc(100vw - 2rem))}
.analyze-trend-decision ul{padding-inline-start:1.3em;margin:0 0 1rem}
.analyze-trend-decision li+li{margin-block-start:.5em}
.analyze-widget-heading:has(>.analyze-widget-toggle:not([hidden])) {display:grid;grid-template-columns:minmax(0,1fr) auto 44px;gap:0 8px;align-items:center}
.analyze-widget-heading>.analyze-widget-toggle {grid-area:1/3;align-self:start;position:relative;isolation:isolate;display:inline-grid;place-items:center;width:44px;min-height:44px;padding:0;border:0;background:transparent;box-shadow:none;color:var(--accent);text-decoration:none}
.analyze-widget-toggle::before {content:"";position:absolute;inset:6px;border-radius:var(--radius-control);z-index:-1;pointer-events:none}
.analyze-widget-toggle:hover::before {background:var(--hover)}
.analyze-widget-toggle:active::before {background:var(--pill-pressed)}
.analyze-widget-toggle:focus-visible {outline:none}
.analyze-widget-toggle:focus-visible::before {outline:2px solid var(--focus);outline-offset:1px}
.analyze-widget-toggle>.wire-icon {width:18px;height:18px}
.analyze-widget[data-collapsed=true] .analyze-widget-body {display:none!important}
.analyze-widget[data-collapsed=true] :is(.chart-panel,#outcomeChart>.percentage-card),
.analyze-widget[data-collapsed=true]:is(.percentage-card) {padding-bottom:var(--widget-heading-inset)}
.analyze-widget[data-collapsed=true] .analyze-widget-heading {margin-bottom:0!important}
#activityListContext.analyze-widget-heading:has(>.analyze-widget-toggle:not([hidden])) {grid-template-columns:minmax(0,1fr) auto 44px}
#activityListContext.analyze-widget-heading>.usage-sort {grid-column:2;grid-row:1}
@container (max-width:30rem) {
 .analyze-widget-heading:has(>.analyze-widget-toggle:not([hidden])) {grid-template-columns:minmax(0,1fr) 44px}
 .analyze-widget-heading>.analyze-widget-toggle {grid-area:1/2}
 .analyze-widget-heading>.analyze-trend-link:not([hidden]) {grid-area:2/1;justify-self:start}
 #activityListContext.analyze-widget-heading:has(>.analyze-widget-toggle:not([hidden])) {grid-template-columns:minmax(0,1fr) 44px}
 #activityListContext.analyze-widget-heading>.usage-sort {grid-column:1/-1;grid-row:3;justify-self:start}
}
#homeView #chart>.empty-state {padding:8px 0 12px;background:none;border:0;border-radius:0;text-align:start}
#homeView #chart>.empty-state>h3 {font:inherit;color:var(--muted)}
#homeView #chart>.empty-state>p {margin:8px 0 0}
#homeView :is(.chart-heading h2,.percentage-card h3) {text-transform:none;letter-spacing:0;font-size:var(--type-section);font-weight:var(--weight-medium)}
.percentage-legend .wire-icon {width:var(--icon-utility-size);height:var(--icon-utility-size)}
.analyze-chart-main #chartFooter {margin-top:8px;line-height:1.5}
.analyze-chart-main #chartFooter:empty {display:none}
#percentageCharts .percentage-section {margin-block:20px 16px}
#percentageCharts .percentage-panels {gap:16px;align-items:start}
#percentageCharts .percentage-card {padding:var(--widget-heading-inset) 20px 16px}
#percentageCharts .percentage-card-heading {margin-bottom:4px;min-height:0}
#percentageCharts .percentage-card {container:breakdown-card / inline-size}
#percentageCharts .percentage-legend {gap:4px}
:is(#outcomeChart,#percentageCharts,.analyze-ordered-widgets) .percentage-legend-row {position:relative;border-radius:var(--radius-small)}
:is(#outcomeChart,#percentageCharts,.analyze-ordered-widgets) .percentage-legend-row .percentage-label[href]::after {content:"";position:absolute;inset:0;z-index:1}
:is(#outcomeChart,#percentageCharts,.analyze-ordered-widgets) .percentage-content:not(.outcome-hybrid) .percentage-legend:not(.percentage-tool-list) .percentage-legend-row {
 &:has(.percentage-label[href]:hover) {background:var(--hover)}
 &:has(.percentage-label[href]:active) {background:var(--pill-pressed)}
 &:has(.percentage-label:focus-visible) {outline:2px solid var(--focus)}
 & .percentage-label[href]:is(:hover,:active,:focus-visible) {background:transparent;outline:none}
}
#activityList .widget-record {display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,auto);gap:4px 24px;align-items:center;padding:8px 16px;overflow-wrap:anywhere}
.widget-record>.text-link,.widget-record-exit {display:inline-flex;align-items:center;justify-self:start;min-height:44px}
.widget-record-meta {display:grid;gap:2px;min-width:0;font-size:var(--type-small)}
.widget-record-meta .semantic-cue {font-weight:var(--weight-regular)}
.widget-record-exit {padding-inline:16px}
@container (max-width:34rem){#activityList .widget-record {grid-template-columns:minmax(0,1fr)}}
@media (hover:none) {
 :is(#outcomeChart,#percentageCharts) .percentage-content:not(.outcome-hybrid) .percentage-label[aria-description]::before {content:attr(aria-description);display:block;font-size:var(--type-caption);font-weight:var(--weight-regular);color:var(--muted);order:1}
 :is(#outcomeChart,#percentageCharts) .percentage-content:not(.outcome-hybrid) .percentage-label[aria-description]:not(.author-option-value) {display:flex;flex-direction:column;justify-content:center}
}
#percentageCharts .percentage-gap-list {margin:4px 0 0;padding-inline-start:28px;font-size:var(--type-caption);color:var(--muted)}
#percentageCharts .percentage-gap-list>div {padding-block:2px}
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
 .analyze-dashboard[data-dashboard-layout=packed] {grid-template-columns:minmax(0,1fr)}
}
@container breakdown-card (min-width:30rem) {
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-legend {grid-template-columns:24px minmax(0,14rem) minmax(2rem,1fr) max-content;column-gap:8px}
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-legend-row {grid-column:1/-1;grid-template-columns:subgrid}
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-bar-track {grid-column:3;grid-row:1}
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-value {grid-column:4;grid-row:1}
 ${readings} {grid-template-columns:fit-content(40%) max-content minmax(3rem,1fr);column-gap:var(--space-md)}
 ${readings} .percentage-legend-row {grid-column:1/-1;grid-template-columns:subgrid;column-gap:inherit}
 ${readings} .percentage-label {grid-area:1/1;min-width:0}
 ${readings} .percentage-value {grid-area:1/2}
 ${readings} .percentage-bar-track {grid-area:1/3}
}
@container breakdown-card (min-width:36rem) {
 ${pairs} {grid-template-columns:repeat(2,minmax(0,1fr));gap:6px clamp(20px,3.6cqi,44px)}
 ${pairs} .percentage-legend-row {grid-column:auto;grid-template-columns:fit-content(70%) minmax(0,1fr);grid-template-rows:auto 6px;gap:0 var(--space-sm);align-self:start;padding-block-end:var(--space-xs)}
 ${pairs} .percentage-label {justify-self:stretch;padding-inline:var(--space-xs)}
 ${pairs} .percentage-value {justify-self:start}
 ${pairs} .percentage-bar-track {grid-area:2/1/3/-1;height:6px}
}
@container breakdown-card (min-width:16rem) and (max-width:29.999rem) {
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-legend-row {grid-template-columns:24px minmax(0,1fr) max-content}
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-tool-list .percentage-legend-row {grid-template-columns:minmax(0,1fr) max-content}
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-value {grid-column:3;justify-content:flex-end;text-align:end}
 :is(#percentageCharts,.analyze-ordered-widgets) .percentage-tool-list .percentage-value {grid-column:2}
}
@media (pointer:fine) {${readings} .percentage-label {min-height:32px}}
@media (pointer:coarse) {${readings} .percentage-label {min-height:44px}}
/* The shell owns 16px; account for the last row's paint, not only its hit box.
   Inline service rows already supply the remaining inset. Stacked tracks do not. */
${breakdownContent} {--widget-label-tail:var(--space-sm);padding-block-end:var(--space-lg)}
@media(pointer:coarse) {${breakdownContent} {--widget-label-tail:0px}}
${breakdownContent}:has(>.percentage-empty:only-child) {padding-block-end:0}
:is(#percentageCharts,.analyze-ordered-widgets) .percentage-empty {padding-block-end:var(--space-lg);text-box:trim-end cap alphabetic}
${breakdownContent}:has(>.percentage-tool-list):not(:has(.percentage-bar-track)) {padding-block-end:var(--widget-label-tail)}
@container breakdown-card (min-width:30rem) {
 ${breakdownContent} {padding-block-end:0}
 ${breakdownContent}:has(>.percentage-tool-list) {padding-block-end:var(--widget-label-tail)}
 :is(#percentageCharts,.analyze-ordered-widgets) [data-breakdown=authors] .percentage-content {padding-block-end:var(--space-sm)}
}
@container breakdown-card (min-width:36rem) {
 ${breakdownContent}:has(>.percentage-tool-list>:nth-child(4)) {padding-block-end:var(--space-md)}
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
#homeView[data-empty=true]>.analyze-dashboard:not([hidden]):has(>#analyzeUsage .token-history) {display:block}
#homeView[data-empty=true]>.analyze-dashboard:has(>#analyzeUsage .token-history)>:not(#analyzeUsage) {display:none}

.analyze-toolbar,.workspace-command-tools {display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:var(--space-sm);min-width:0;max-width:100%}
.workspace-command-row{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:var(--space-xs) var(--space-md);min-width:0}
.workspace-command-context{margin-inline-end:auto;min-width:0;color:var(--muted);font-size:var(--type-control)}
.workspace-command-tools{margin-inline-start:auto}
#workspace>#analyzeReferenceEntry {max-width:none;margin-bottom:var(--space-md)}
#workspace>#analyzeResultCommands {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:var(--space-xs) var(--space-md);max-width:none;margin-bottom:var(--space-md)}
#workspace>#analyzeResultCommands[hidden] {display:none}
#analyzeResultScope {min-width:0;align-self:center}
#analyzeResultScope .analyze-scope-summary {margin:0;padding:0;border:0}
#analyzeResultScope .analyze-scope-caption {margin:0}
#analyzeResultScope #periodResult:not(.visually-hidden) {display:block;margin:0;color:var(--muted);font-size:var(--type-control)}
#analyzeResultScope #periodResult :is(#activityCount,#activityUnit) {font:inherit;letter-spacing:normal;color:inherit}
.population-link {display:inline-block;padding-block:var(--control-face-inset);color:inherit}
.population-link:is(:hover,:focus-visible) {color:var(--accent)}
.analyze-toolbar[hidden] {display:none}
:is(#openAnalyzeFilters,.trends-filter-actions>.filter-entry) {--action-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:max(44px,calc(1lh + 16px));padding:8px 12px;white-space:nowrap;overflow-wrap:normal;font-size:var(--type-control);line-height:var(--leading-control);--pill-border:var(--control);--pill-hover-border:var(--control);flex:none;color:var(--ink)}
:is(#openAnalyzeFilters,.trends-filter-actions>.filter-entry)>.wire-icon {width:1rem;height:1rem;flex:none;color:inherit}
#analyzeRefresh {--action-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:44px;min-height:max(44px,calc(1lh + 16px));padding:8px 12px;white-space:nowrap;font-size:var(--type-control);line-height:var(--leading-control)}
#analyzeRefresh>.wire-icon {width:1rem;height:1rem;flex:none}
#analyzeRefreshLabel {min-inline-size:7ch;text-align:start}
.analyze-toolbar>.ux-disabled-help {flex:none}
#analyzeRefresh:focus-visible {outline:none}
#analyzeRefresh:focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
:is(#openAnalyzeFilters,.trends-filter-actions>.filter-entry):focus-visible {outline:none}
:is(#openAnalyzeFilters,.trends-filter-actions>.filter-entry):focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
/* One stable target for the longest (two-digit) accepted label, also at enlarged type. */
.filter-entry {inline-size:11em;max-inline-size:100%;justify-content:center;font-variant-numeric:tabular-nums}
.filter-entry.has-applied-filters:not(:disabled) {--pill-fill:var(--accent-soft);--pill-border:var(--control);--pill-hover:var(--accent-hover);--pill-hover-border:var(--control)}
@media(max-width:550px) {
 #workspace>#analyzeResultCommands {grid-template-columns:minmax(0,1fr)}
 #analyzeResultScope {order:1}
 #analyzeResultCommands .analyze-toolbar {justify-self:end}
}
.analyze-filter-dialog {margin:0;inset:var(--analyze-panel-top,120px) clamp(16px,var(--analyze-panel-right,24px),max(16px,calc(100vw - 48rem - 16px))) auto auto;width:min(48rem,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - var(--analyze-panel-top,120px) - 16px);padding:0;border:1px solid var(--surface-divider);border-radius:var(--radius-dialog);background:var(--floating-paper);color:var(--ink);box-shadow:var(--surface-shadow);scroll-padding-top:76px}
.analyze-filter-dialog::backdrop {background:var(--scrim)}
.analyze-filter-dialog {scrollbar-gutter:stable}
.analyze-filter-dialog[open]:not(:modal){position:fixed;z-index:30}
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
#dateFilter-control {margin:0;width:100%;text-align:start}
#analyzeDates {grid-column:1/-1;box-sizing:border-box;width:min(100%,24rem);min-width:0;padding:var(--space-lg);border:1px solid var(--rule);border-radius:var(--radius-control)}
.period-comparing #analyzeDates {display:none}
#analyzeFilterPanel #dateFields {display:grid;grid-template-columns:minmax(0,1fr);width:100%}
#analyzeFilterPanel #dateFields #dateError {grid-column:1/-1}
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
.analyze-reading:not(.period-comparing) .page-heading {margin:0 0 var(--space-lg);min-height:0}
.analyze-reading:not(.period-comparing) #activityView:has(#activityListContext) #activityTitle {position:absolute!important;width:1px;height:1px;padding:0;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.analyze-reading:not(.period-comparing) #activityView {position:relative;margin-top:16px}
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
.percentage-total-link {pointer-events:auto;display:grid;place-items:center;min-width:44px;min-height:44px;border-radius:var(--radius-small);color:var(--ink);text-decoration:none}
.percentage-total-link:is(:hover,:focus-visible) {color:var(--accent);background:var(--hover)}
.percentage-total-unit {font-size:var(--type-small);line-height:var(--leading-caption);color:var(--muted)}
.percentage-total[data-length=long] .percentage-total-value {font-size:1.25rem}
.percentage-total[data-length=wide] {position:static;aspect-ratio:auto}
:is(#outcomeChart,.native-outcome-chart) .percentage-visual:has(.percentage-total[data-length=wide]) {width:100%}
:is(#outcomeChart,.native-outcome-chart) .percentage-visual:has(.percentage-total[data-length=wide])>svg {width:min(13rem,100%);display:block;margin-inline:auto}
.percentage-total[data-length=wide] .percentage-total-value {font-size:var(--type-data-value);overflow-wrap:anywhere}
.analyze-outcome-summary #outcomeChart .percentage-content.outcome-hybrid {
 --hybrid-wheel:clamp(12rem,18cqi,17.5rem);
 display:grid;grid-template-columns:minmax(0,var(--hybrid-wheel)) minmax(0,1fr);gap:clamp(16px,2.2cqi,40px);align-items:center;padding-block:4px var(--space-lg)
}
/* The ring frame has 16 units of unpainted edge in its 240-unit viewBox. */
#outcomeChart .outcome-hybrid .percentage-visual {width:var(--hybrid-wheel);max-width:100%;margin:0 0 calc(-1 * var(--hybrid-wheel) / 15)}
#outcomeChart .outcome-hybrid .percentage-total {gap:.16rem}
#outcomeChart .outcome-hybrid .percentage-total-value {font-size:clamp(2rem,3.3cqi,3.5rem);line-height:1;letter-spacing:-.035em}
#outcomeChart .outcome-hybrid .percentage-total[data-length=long] .percentage-total-value {font-size:clamp(1rem,2cqi,2rem)}
#outcomeChart .outcome-hybrid .percentage-total[data-length=wide] .percentage-total-value {font-size:var(--type-data-value)}
#outcomeChart .outcome-hybrid .percentage-total-unit {font-size:clamp(.875rem,1.1cqi,1.1rem);line-height:1.2}
.outcome-distribution {min-width:0}
.outcome-share-strip {display:flex;height:clamp(18px,1.8cqi,32px);margin-block-end:var(--space-md)}
.outcome-share-strip>* {flex-basis:0;min-width:0;background:var(--column-label)}
.outcome-share-strip>.percentage-active {outline:2px solid var(--ink);outline-offset:-2px}
.outcome-hybrid .percentage-face.percentage-active {stroke:var(--ink);stroke-width:1.5px;vector-effect:non-scaling-stroke;paint-order:stroke fill}
.outcome-hybrid .percentage-legend-row.percentage-active .percentage-label[href] {background:var(--hover)}
.outcome-hybrid .percentage-legend-row.percentage-active .percentage-label[href]:active {background:var(--pill-pressed)}
#outcomeChart .outcome-hybrid .percentage-legend {display:flex;flex-wrap:wrap;gap:4px clamp(20px,4cqi,64px)}
#outcomeChart .outcome-hybrid .percentage-legend-row {grid-template-columns:auto minmax(0,1fr);gap:0 6px;align-items:center;align-content:start;justify-items:start}
#outcomeChart .outcome-hybrid .percentage-label {font-size:clamp(1rem,1.25cqi,1.25rem)}
#outcomeChart .outcome-hybrid .percentage-value {grid-column:2;justify-self:start;padding-inline:6px;font-size:clamp(1.35rem,2.05cqi,2rem);line-height:1.2}
#outcomeChart .outcome-hybrid .percentage-value>span {font-size:.75em}
#outcomeChart .outcome-distribution>.outcome-zeros {margin-block-start:var(--space-xs);gap:0 var(--space-lg)}
#outcomeChart .outcome-distribution>.outcome-zeros .percentage-legend-row {display:flex;align-items:center;gap:4px}
#outcomeChart .outcome-distribution>.outcome-zeros :is(.percentage-label,.percentage-value) {padding-inline:2px;font-size:var(--type-small);color:var(--muted)}
#outcomeChart .outcome-distribution>.outcome-zeros .percentage-value :is(strong,span) {font-size:inherit;font-weight:var(--weight-regular)}
@container outcome-card (min-width:48.001rem) {
 #outcomeChart .outcome-distribution>.percentage-legend:not(.outcome-zeros):has(>:nth-child(3)) {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));justify-items:start;gap:var(--space-sm) var(--space-lg)}
}
@container outcome-card (max-width:48rem) {
 .analyze-outcome-summary #outcomeChart .percentage-content.outcome-hybrid {--hybrid-wheel:clamp(9rem,23cqi,11rem);column-gap:var(--space-lg)}
 #outcomeChart .percentage-content.outcome-hybrid .percentage-legend:not(.outcome-zeros) {display:grid;grid-template-columns:minmax(0,1fr);gap:0}
 #outcomeChart .percentage-content.outcome-hybrid .percentage-legend-row {grid-template-columns:18px minmax(0,1fr) auto;gap:4px}
 #outcomeChart .percentage-content.outcome-hybrid .percentage-value {grid-column:3;grid-row:1;justify-self:end;padding:0;font-size:1rem}
 #outcomeChart .outcome-hybrid .percentage-value>span {font-size:.9em}
 #outcomeChart .outcome-hybrid .percentage-total-value {font-size:1.7rem}
 #outcomeChart .outcome-hybrid .percentage-total-unit {font-size:.875rem}
 .outcome-share-strip {height:14px;margin-block-end:4px}
}
@container outcome-card (max-width:28rem) {
 .analyze-outcome-summary #outcomeChart .percentage-content.outcome-hybrid {--hybrid-wheel:11rem;grid-template-columns:minmax(0,1fr);gap:var(--space-sm);padding-block-end:0}
 #outcomeChart .percentage-content.outcome-hybrid .percentage-visual {justify-self:center;max-width:100%}
 .outcome-share-strip {height:12px}
}
@container outcome-card (max-width:12rem) {
 #outcomeChart .percentage-content.outcome-hybrid .percentage-legend-row {grid-template-columns:18px minmax(0,1fr)}
 #outcomeChart .percentage-content.outcome-hybrid .percentage-value {grid-area:2/2;justify-self:start;padding-inline:6px}
}
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
 .outcome-share-strip>.percentage-active,.outcome-hybrid .percentage-face.percentage-active {outline-color:Highlight;stroke:Highlight}
 .analyze-filter-dialog,.analyze-scope-summary,.analyze-tools,.analyze-view-controls {border-color:CanvasText;box-shadow:none}
}
`;
